import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { fail, ok, TResult } from '@common/types';
import { getSystemStats } from '@common/utils/get-system-stats';
import { ERRORS } from '@libs/contracts/constants';

import { GetTorrentBlockerReportsCountQuery } from '../_plugin/queries/get-torrent-blocker-reports-count';
import { CoreStateService } from '../core/core-state.service';
import { SingBoxStatsService } from '../core/singbox-stats.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { IGetUserOnlineStatusRequest } from './interfaces';
import {
    GetAllInboundsStatsResponseModel,
    GetAllOutboundsStatsResponseModel,
    GetCombinedStatsResponseModel,
    GetInboundStatsResponseModel,
    GetOutboundStatsResponseModel,
    GetSystemStatsResponseModel,
    GetUserIpListResponseModel,
    GetUserOnlineStatusResponseModel,
    GetUsersIpListResponseModel,
    GetUsersStatsResponseModel,
} from './models';

@Injectable()
export class StatsService {
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        private readonly queryBus: QueryBus,
        private readonly coreState: CoreStateService,
        private readonly singBoxStats: SingBoxStatsService,
    ) {}
    private readonly logger = new Logger(StatsService.name);

    public async getUserOnlineStatus(
        body: IGetUserOnlineStatusRequest,
    ): Promise<TResult<GetUserOnlineStatusResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                return {
                    isOk: true,
                    response: new GetUserOnlineStatusResponseModel(false),
                };
            }

            const response = await this.xtlsSdk.stats.getUserOnlineStatus(body.username);

            if (response.isOk && response.data) {
                return ok(new GetUserOnlineStatusResponseModel(response.data.online));
            }

            return ok(new GetUserOnlineStatusResponseModel(false));
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: true,
                response: new GetUserOnlineStatusResponseModel(false),
            };
        }
    }

    public async getSystemStats(): Promise<TResult<GetSystemStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const response = await this.singBoxStats.getSysStats();
                const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
                const systemStats = getSystemStats();
                const reportsCount = await this.queryBus.execute(
                    new GetTorrentBlockerReportsCountQuery(),
                );

                return {
                    isOk: true,
                    response: new GetSystemStatsResponseModel(
                        {
                            numGoroutine: Number(response.NumGoroutine),
                            numGC: Number(response.NumGC),
                            alloc: Number(response.Alloc),
                            totalAlloc: Number(response.TotalAlloc),
                            sys: Number(response.Sys),
                            mallocs: Number(response.Mallocs),
                            frees: Number(response.Frees),
                            liveObjects: Number(response.LiveObjects),
                            pauseTotalNs: Number(response.PauseTotalNs),
                            uptime: Number(response.Uptime),
                        },
                        {
                            torrentBlocker: {
                                reportsCount,
                            },
                        },
                        {
                            ...systemStats,
                            interface: interfaceStats,
                        },
                    ),
                };
            }

            const response = await this.xtlsSdk.stats.getSysStats();

            if (!response.isOk || !response.data) {
                this.logger.warn(response);
                return fail(ERRORS.FAILED_TO_GET_SYSTEM_STATS);
            }

            const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
            const systemStats = getSystemStats();
            const reportsCount = await this.queryBus.execute(
                new GetTorrentBlockerReportsCountQuery(),
            );

            return {
                isOk: true,
                response: new GetSystemStatsResponseModel(
                    response.data,
                    {
                        torrentBlocker: {
                            reportsCount,
                        },
                    },
                    {
                        ...systemStats,
                        interface: interfaceStats,
                    },
                ),
            };
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: false,
                ...ERRORS.FAILED_TO_GET_SYSTEM_STATS,
            };
        }
    }

    public async getUsersStats(reset: boolean): Promise<TResult<GetUsersStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, ['user>>>']);
                return {
                    isOk: true,
                    response: new GetUsersStatsResponseModel(
                        Array.from(snapshot.users, ([username, traffic]) => ({
                            username,
                            ...traffic,
                        })).filter((user) => user.uplink !== 0 || user.downlink !== 0),
                    ),
                };
            }

            const response = await this.xtlsSdk.stats.getAllUsersStats(reset);

            if (!response.isOk || !response.data) {
                this.logger.warn(response);

                return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
            }

            return ok(
                new GetUsersStatsResponseModel(
                    response.data.users.filter((user) => user.uplink !== 0 || user.downlink !== 0),
                ),
            );

            // const demoRes = Array.from({ length: 160_000 }, (_, i) => ({
            //     username: String(i + 1),
            //     uplink: Math.floor(Math.random() * (107374182400 - 10485760) + 10485760), // Random between 10MB and 100GB
            //     downlink: Math.floor(Math.random() * (107374182400 - 10485760) + 10485760), // Random between 10MB and 100GB
            // }));

            // return {
            //     isOk: true,
            //     response: new GetUsersStatsResponseModel(demoRes),
            // };
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
        }
    }

    public async getInboundStats(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetInboundStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, [
                    `inbound>>>${tag}>>>traffic>>>`,
                ]);
                const traffic = snapshot.inbounds.get(tag) ?? { uplink: 0, downlink: 0 };
                return {
                    isOk: true,
                    response: new GetInboundStatsResponseModel({
                        inbound: tag,
                        ...traffic,
                    }),
                };
            }

            const response = await this.xtlsSdk.stats.getInboundStats(tag, reset);

            if (!response.isOk || !response.data || !response.data.inbound) {
                return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
            }

            return ok(
                new GetInboundStatsResponseModel({
                    inbound: response.data.inbound.inbound,
                    downlink: response.data.inbound.downlink,
                    uplink: response.data.inbound.uplink,
                }),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
        }
    }

    public async getOutboundStats(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetOutboundStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, [
                    `outbound>>>${tag}>>>traffic>>>`,
                ]);
                const traffic = snapshot.outbounds.get(tag) ?? { uplink: 0, downlink: 0 };
                return {
                    isOk: true,
                    response: new GetOutboundStatsResponseModel({
                        outbound: tag,
                        ...traffic,
                    }),
                };
            }

            const response = await this.xtlsSdk.stats.getOutboundStats(tag, reset);

            if (!response.isOk || !response.data || !response.data.outbound) {
                return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
            }

            return ok(
                new GetOutboundStatsResponseModel({
                    outbound: response.data.outbound.outbound,
                    downlink: response.data.outbound.downlink,
                    uplink: response.data.outbound.uplink,
                }),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
        }
    }

    public async getAllInboundsStats(
        reset: boolean,
    ): Promise<TResult<GetAllInboundsStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, ['inbound>>>']);
                return {
                    isOk: true,
                    response: new GetAllInboundsStatsResponseModel(
                        Array.from(snapshot.inbounds, ([inbound, traffic]) => ({
                            inbound,
                            ...traffic,
                        })),
                    ),
                };
            }

            const response = await this.xtlsSdk.stats.getAllInboundsStats(reset);

            if (!response.isOk || !response.data) {
                return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
            }

            return ok(new GetAllInboundsStatsResponseModel(response.data.inbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getAllOutboundsStats(
        reset: boolean,
    ): Promise<TResult<GetAllOutboundsStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, ['outbound>>>']);
                return {
                    isOk: true,
                    response: new GetAllOutboundsStatsResponseModel(
                        Array.from(snapshot.outbounds, ([outbound, traffic]) => ({
                            outbound,
                            ...traffic,
                        })),
                    ),
                };
            }

            const response = await this.xtlsSdk.stats.getAllOutboundsStats(reset);

            if (!response.isOk || !response.data) {
                this.logger.error(response);
                return fail(ERRORS.FAILED_TO_GET_OUTBOUNDS_STATS);
            }

            return ok(new GetAllOutboundsStatsResponseModel(response.data.outbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getCombinedStats(reset: boolean): Promise<TResult<GetCombinedStatsResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                const snapshot = await this.singBoxStats.getSnapshot(reset, [
                    'inbound>>>',
                    'outbound>>>',
                ]);
                return {
                    isOk: true,
                    response: new GetCombinedStatsResponseModel(
                        Array.from(snapshot.inbounds, ([inbound, traffic]) => ({
                            inbound,
                            ...traffic,
                        })),
                        Array.from(snapshot.outbounds, ([outbound, traffic]) => ({
                            outbound,
                            ...traffic,
                        })),
                    ),
                };
            }

            const { isOk: isOkInbounds, data: inboundsData } =
                await this.xtlsSdk.stats.getAllInboundsStats(reset);
            const { isOk: isOkOutbounds, data: outboundsData } =
                await this.xtlsSdk.stats.getAllOutboundsStats(reset);

            if (!isOkInbounds || !inboundsData || !isOkOutbounds || !outboundsData) {
                return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
            }

            return ok(
                new GetCombinedStatsResponseModel(inboundsData.inbounds, outboundsData.outbounds),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
        }
    }

    public async getUserIpList(userId: string): Promise<TResult<GetUserIpListResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                return {
                    isOk: true,
                    response: new GetUserIpListResponseModel([]),
                };
            }

            const userIps = await this.xtlsSdk.stats.rawClient.getStatsOnlineIpList({
                name: `user>>>${userId}>>>online`,
                reset: true,
            });

            const ips = Object.entries(userIps.ips).map(([ip, timestamp]) => ({
                ip,
                lastSeen: new Date(timestamp * 1000),
            }));

            return ok(new GetUserIpListResponseModel(ips));
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 5) {
                return ok(new GetUserIpListResponseModel([]));
            }

            this.logger.error(error);
            return ok(new GetUserIpListResponseModel([]));
        }
    }

    public async getUsersIpList(): Promise<TResult<GetUsersIpListResponseModel>> {
        try {
            if (this.coreState.isSingBoxActive()) {
                return {
                    isOk: true,
                    response: new GetUsersIpListResponseModel([]),
                };
            }

            const response = await this.xtlsSdk.stats.getUsersStats(false, false);

            if (!response.isOk || !response.data || !response.data.users) {
                this.logger.error(response);
                return ok(new GetUsersIpListResponseModel([]));
            }

            return ok(new GetUsersIpListResponseModel(response.data.users));
        } catch (error) {
            this.logger.error(error);
            return ok(new GetUsersIpListResponseModel([]));
        }
    }
}
