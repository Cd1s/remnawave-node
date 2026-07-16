import ems from 'enhanced-ms';
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pRetry from 'p-retry';
import semver from 'semver';

import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { ICommandResponse } from '@common/types/command-response.type';
import { getSystemInfo, getSystemStats } from '@common/utils/get-system-stats';
import { StartXrayCommand } from '@libs/contracts/commands';
import { CORE_TYPE } from '@libs/contracts/constants';

import { InternalService } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { StartXrayResponseModel, StopXrayResponseModel } from '../xray-core/models';
import { CoreStateService } from './core-state.service';
import { SingBoxProcessService } from './singbox-process.service';
import { SingBoxStatsService } from './singbox-stats.service';

const execFileAsync = promisify(execFile);
const SINGBOX_LOG_FILE = '/var/log/sing-box/current';

interface ISingBoxInbound extends Record<string, unknown> {
    tag?: string;
    users?: Record<string, unknown>[];
}

interface ISingBoxConfig extends Record<string, unknown> {
    inbounds?: ISingBoxInbound[];
    outbounds?: Record<string, unknown>[];
    experimental?: Record<string, unknown>;
}

export interface ISingBoxUserMutation {
    tag: string;
    type: string;
    name: string;
    password?: string;
    uuid?: string;
    flow?: string;
}

@Injectable()
export class SingBoxService {
    private readonly logger = new Logger(SingBoxService.name);
    private readonly configPath = process.env.SINGBOX_CONFIG_PATH ?? '/run/remnawave/sing-box.json';
    private readonly singBoxPath = process.env.SINGBOX_PATH ?? '/usr/local/bin/sing-box';
    private readonly apiListen = process.env.SINGBOX_API_LISTEN ?? '127.0.0.1:19090';
    private readonly disableHashedSetCheck: boolean;

    private isStartProcessing = false;
    private version: string | null = null;
    private currentConfig: ISingBoxConfig | null = null;
    private nodeVersion = '0.0.0';

    constructor(
        private readonly processService: SingBoxProcessService,
        private readonly statsService: SingBoxStatsService,
        private readonly coreState: CoreStateService,
        private readonly internalService: InternalService,
        private readonly queryBus: QueryBus,
    ) {
        this.disableHashedSetCheck = process.env.DISABLE_HASHED_SET_CHECK === 'true';
        this.version = this.getVersionFromEnv();
        this.nodeVersion = __RWNODE_VERSION__ ?? '0.0.0';
    }

    public async start(
        body: StartXrayCommand.Request,
        ip: string,
    ): Promise<ICommandResponse<StartXrayResponseModel>> {
        const startedAt = performance.now();
        const system = await this.getSystem();

        if (this.isStartProcessing) {
            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    false,
                    CORE_TYPE.SINGBOX,
                    this.version,
                    'Request already in progress',
                    { version: this.nodeVersion },
                    system,
                ),
            };
        }

        this.isStartProcessing = true;

        try {
            if (
                this.coreState.isSingBoxActive() &&
                !this.disableHashedSetCheck &&
                !body.internals.forceRestart
            ) {
                await this.statsService.getSysStats();
                if (!this.internalService.isNeedRestartCore(body.internals.hashes)) {
                    return {
                        isOk: true,
                        response: new StartXrayResponseModel(
                            true,
                            CORE_TYPE.SINGBOX,
                            this.version,
                            null,
                            { version: this.nodeVersion },
                            system,
                        ),
                    };
                }
            }

            const fullConfig = this.injectManagementApi(body.xrayConfig);
            await this.internalService.extractUsersFromConfig(
                body.internals.hashes,
                fullConfig,
                CORE_TYPE.SINGBOX,
            );

            if (this.coreState.isSingBoxActive()) {
                await this.statsService.accumulateAndReset();
            }

            await this.writeAndValidateConfig(fullConfig);
            await this.processService.restart();
            await this.waitUntilReady();

            this.currentConfig = fullConfig;
            this.version = await this.resolveVersion();
            this.coreState.setActiveCore(CORE_TYPE.SINGBOX, true, this.version);

            this.logger.log(`✔ sing-box v${this.version ?? 'unknown'} is up and running.`);

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    true,
                    CORE_TYPE.SINGBOX,
                    this.version,
                    null,
                    { version: this.nodeVersion },
                    system,
                ),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.coreState.setOffline(CORE_TYPE.SINGBOX);
            this.logger.error(`Failed to start sing-box: ${message}`);
            await this.dumpTailBlock(SINGBOX_LOG_FILE, 8);

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    false,
                    CORE_TYPE.SINGBOX,
                    this.version,
                    message,
                    { version: this.nodeVersion },
                    system,
                ),
            };
        } finally {
            this.logger.log(
                `Attempt to start sing-box took: ${ems(performance.now() - startedAt, {
                    extends: 'short',
                    includeMs: true,
                })} (IP: ${ip})`,
            );
            this.isStartProcessing = false;
        }
    }

    public async stop(): Promise<ICommandResponse<StopXrayResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                try {
                    await this.statsService.accumulateAndReset();
                } catch (error) {
                    this.logger.warn(`Failed to snapshot sing-box stats before stop: ${error}`);
                }
            }

            await this.processService.stop();
            this.coreState.setOffline(CORE_TYPE.SINGBOX);
            this.currentConfig = null;

            return {
                isOk: true,
                response: new StopXrayResponseModel(true),
            };
        } catch (error) {
            this.logger.error(`Failed to stop sing-box: ${error}`);
            return {
                isOk: true,
                response: new StopXrayResponseModel(false),
            };
        }
    }

    public async mutateUsers(mutate: (inbounds: ISingBoxInbound[]) => void): Promise<void> {
        if (!this.currentConfig?.inbounds || !this.coreState.isSingBoxActive()) {
            throw new Error('sing-box is not active');
        }

        await this.statsService.accumulateAndReset();
        mutate(this.currentConfig.inbounds);
        const nextConfig = this.injectManagementApi(this.currentConfig);
        await this.writeAndValidateConfig(nextConfig);
        await this.processService.restart();
        await this.waitUntilReady();
        this.currentConfig = nextConfig;
    }

    public getCurrentConfig(): ISingBoxConfig | null {
        return this.currentConfig;
    }

    public async upsertUsers(usernames: string[], users: ISingBoxUserMutation[]): Promise<void> {
        const usernameSet = new Set(usernames);
        await this.mutateUsers((inbounds) => {
            for (const inbound of inbounds) {
                inbound.users = (inbound.users ?? []).filter(
                    (user) => !usernameSet.has(String(user.name)),
                );
            }

            const inboundsByTag = new Map(
                inbounds
                    .filter((inbound) => typeof inbound.tag === 'string')
                    .map((inbound) => [inbound.tag!, inbound]),
            );

            for (const user of users) {
                const inbound = inboundsByTag.get(user.tag);
                if (!inbound) continue;

                inbound.users ??= [];
                switch (user.type) {
                    case 'anytls':
                    case 'trojan':
                    case 'shadowsocks':
                    case 'shadowsocks22':
                        inbound.users.push({
                            name: user.name,
                            password: user.password,
                        });
                        break;
                    case 'vless':
                        inbound.users.push({
                            name: user.name,
                            uuid: user.uuid,
                            ...(user.flow ? { flow: user.flow } : {}),
                        });
                        break;
                }
            }
        });
    }

    public async removeUsers(usernames: string[]): Promise<void> {
        const usernameSet = new Set(usernames);
        await this.mutateUsers((inbounds) => {
            for (const inbound of inbounds) {
                inbound.users = (inbound.users ?? []).filter(
                    (user) => !usernameSet.has(String(user.name)),
                );
            }
        });
    }

    public getInboundUsers(tag: string): string[] {
        const inbound = this.currentConfig?.inbounds?.find((item) => item.tag === tag);
        return (inbound?.users ?? [])
            .map((user) => user.name)
            .filter((name): name is string => typeof name === 'string');
    }

    public getVersion(): string | null {
        return this.version;
    }

    private injectManagementApi(config: Record<string, unknown>): ISingBoxConfig {
        const cloned = structuredClone(config) as ISingBoxConfig;
        const inbounds = cloned.inbounds ?? [];
        const outbounds = cloned.outbounds ?? [];
        const users = new Set<string>();

        for (const inbound of inbounds) {
            for (const user of inbound.users ?? []) {
                if (typeof user.name === 'string') users.add(user.name);
            }
        }

        cloned.experimental = {
            ...cloned.experimental,
            v2ray_api: {
                listen: this.apiListen,
                stats: {
                    enabled: true,
                    inbounds: inbounds
                        .map((inbound) => inbound.tag)
                        .filter((tag): tag is string => typeof tag === 'string'),
                    outbounds: outbounds
                        .map((outbound) => outbound.tag)
                        .filter((tag): tag is string => typeof tag === 'string'),
                    users: Array.from(users),
                },
            },
        };

        return cloned;
    }

    private async writeAndValidateConfig(config: ISingBoxConfig): Promise<void> {
        const temporaryPath = `${this.configPath}.tmp`;
        await mkdir(this.configPath.slice(0, this.configPath.lastIndexOf('/')), {
            recursive: true,
        });
        await writeFile(temporaryPath, JSON.stringify(config, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await execFileAsync(this.singBoxPath, ['check', '-c', temporaryPath]);
        await rename(temporaryPath, this.configPath);
    }

    private async waitUntilReady(): Promise<void> {
        await pRetry(
            async () => {
                const status = await this.processService.getStatus();
                if (!status.up) throw new Error('sing-box process is not up');
                await this.statsService.getSysStats();
            },
            {
                retries: 30,
                minTimeout: 100,
                maxTimeout: 2_000,
                factor: 1.5,
            },
        );
    }

    private async resolveVersion(): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(this.singBoxPath, ['version']);
            return semver.valid(semver.coerce(stdout));
        } catch {
            return this.getVersionFromEnv();
        }
    }

    private getVersionFromEnv(): string | null {
        return semver.valid(semver.coerce(process.env.SINGBOX_CORE_VERSION));
    }

    private async getSystem() {
        const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
        return {
            info: getSystemInfo(),
            stats: getSystemStats(),
            interface: interfaceStats,
        };
    }

    private async dumpTailBlock(path: string, lines: number): Promise<void> {
        try {
            const { stdout } = await execFileAsync('tail', ['-n', String(lines), path]);
            const tail = stdout.split('\n').filter(Boolean);
            if (tail.length > 0) {
                this.logger.error(
                    ['sing-box Log Tail', ...tail.map((line) => `│ ${line}`)].join('\n'),
                );
            }
        } catch {
            // No log exists yet.
        }
    }
}
