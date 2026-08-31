import ems from 'enhanced-ms';
import { hasCapNetAdmin } from 'sockdestroy';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';
import { ISdkResponse } from '@remnawave/xtls-sdk/build/src/common/types';
import {
    RemoveUserResponseModel as RemoveUserResponseModelFromSdk,
    AddUserResponseModel as AddUserResponseModelFromSdk,
} from '@remnawave/xtls-sdk/build/src/handler/models';

import { fail, ok, TResult } from '@common/types';
import { ERRORS } from '@libs/contracts/constants/errors';

import { DropConnectionsEvent } from '../_plugin/events/drop-connections';
import { CoreStateService } from '../core/core-state.service';
import { ISingBoxUserMutation, SingBoxService } from '../core/singbox.service';
import { InternalService } from '../internal/internal.service';
import {
    AddUserRequestDto,
    AddUsersRequestDto,
    DropIpsRequestDto,
    DropUsersConnectionsRequestDto,
    RemoveUserRequestDto,
    RemoveUsersRequestDto,
} from './dtos';
import { AddUserResponseModel, RemoveUserResponseModel, GenericResponseModel } from './models';

@Injectable()
export class HandlerService implements OnModuleInit {
    private readonly logger = new Logger(HandlerService.name);
    private capNetAdminAvailable = false;

    constructor(
        @InjectXtls() private readonly xtlsApi: XtlsApi,
        private readonly internalService: InternalService,
        private readonly eventBus: EventBus,
        private readonly coreState: CoreStateService,
        private readonly singBoxService: SingBoxService,
    ) {}

    public async onModuleInit(): Promise<void> {
        try {
            if (!hasCapNetAdmin()) {
                this.capNetAdminAvailable = false;
                this.logger.warn('CAP_NET_ADMIN is not available.');
            } else {
                this.capNetAdminAvailable = true;
                this.logger.log('[OK] CAP_NET_ADMIN is available');
            }
        } catch (error: unknown) {
            this.logger.error(error);
        }
    }

    public async addUser(data: AddUserRequestDto): Promise<TResult<AddUserResponseModel>> {
        try {
            const { data: requestData, hashData } = data;

            if (this.coreState.isSingBoxActive()) {
                await this.singBoxService.upsertUsers(
                    [requestData[0]?.username].filter(
                        (username): username is string => typeof username === 'string',
                    ),
                    requestData.map((item) => ({
                        tag: item.tag,
                        type: item.type,
                        name: item.username,
                        ...('password' in item ? { password: item.password } : {}),
                        ...('uuid' in item ? { uuid: item.uuid } : {}),
                        ...('flow' in item ? { flow: item.flow } : {}),
                    })),
                );

                return {
                    isOk: true,
                    response: new AddUserResponseModel(true, null),
                };
            }

            const response: Array<ISdkResponse<AddUserResponseModelFromSdk>> = [];
            const userId = requestData[0].username;
            let userIps: string[] | null = null;

            for (const item of requestData) {
                this.internalService.addXtlsConfigInbound(item.tag);
            }

            if (hashData.prevVlessUuid) {
                userIps = await this.getUserIps(userId);
            }

            for (const tag of this.internalService.getXtlsConfigInbounds()) {
                this.logger.debug(`Removing user: ${userId} from tag: ${tag}`);

                await this.xtlsApi.handler.removeUser(tag, userId);

                if (hashData.prevVlessUuid) {
                    await this.internalService.removeUserFromInbound(tag, hashData.prevVlessUuid);
                } else {
                    await this.internalService.removeUserFromInbound(tag, hashData.vlessUuid);
                }
            }

            if (userIps && hashData.prevVlessUuid) {
                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            for (const item of requestData) {
                let tempRes = null;

                this.logger.debug(`Adding user: ${item.username} with type: ${item.type}`);

                switch (item.type) {
                    case 'trojan':
                        tempRes = await this.xtlsApi.handler.addTrojanUser({
                            tag: item.tag,
                            username: item.username,
                            password: item.password,
                            level: 0,
                        });
                        if (tempRes.isOk) {
                            await this.internalService.addUserToInbound(
                                item.tag,
                                hashData.vlessUuid,
                            );
                        }
                        response.push(tempRes);
                        break;
                    case 'vless':
                        tempRes = await this.xtlsApi.handler.addVlessUser({
                            tag: item.tag,
                            username: item.username,
                            uuid: item.uuid,
                            flow: item.flow,
                            level: 0,
                        });
                        if (tempRes.isOk) {
                            await this.internalService.addUserToInbound(
                                item.tag,
                                hashData.vlessUuid,
                            );
                        }
                        response.push(tempRes);
                        break;
                    case 'shadowsocks':
                        tempRes = await this.xtlsApi.handler.addShadowsocksUser({
                            tag: item.tag,
                            username: item.username,
                            password: item.password,
                            cipherType: item.cipherType,
                            ivCheck: false,
                            level: 0,
                        });
                        if (tempRes.isOk) {
                            await this.internalService.addUserToInbound(
                                item.tag,
                                hashData.vlessUuid,
                            );
                        }
                        response.push(tempRes);
                        break;
                    case 'shadowsocks22':
                        tempRes = await this.xtlsApi.handler.addShadowsocks2022User({
                            tag: item.tag,
                            username: item.username,
                            key: item.password,
                            level: 0,
                        });

                        if (tempRes.isOk) {
                            await this.internalService.addUserToInbound(
                                item.tag,
                                hashData.vlessUuid,
                            );
                        }
                        response.push(tempRes);
                        break;
                    case 'hysteria':
                        tempRes = await this.xtlsApi.handler.addHysteriaUser({
                            tag: item.tag,
                            username: item.username,
                            uuid: item.password,
                            level: 0,
                        });

                        if (tempRes.isOk) {
                            await this.internalService.addUserToInbound(
                                item.tag,
                                hashData.vlessUuid,
                            );
                        }
                        response.push(tempRes);

                        break;
                }
            }

            if (response.every((res) => !res.isOk)) {
                this.logger.error('Error adding users: ' + JSON.stringify(response, null, 2));
                return ok(
                    new AddUserResponseModel(
                        false,
                        response.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new AddUserResponseModel(true, null));
        } catch (error) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        }
    }

    public async removeUser(data: RemoveUserRequestDto): Promise<TResult<RemoveUserResponseModel>> {
        try {
            const { username, hashData } = data;

            if (this.coreState.isSingBoxActive()) {
                await this.singBoxService.removeUsers([username]);
                return {
                    isOk: true,
                    response: new RemoveUserResponseModel(true, null),
                };
            }

            const response: Array<ISdkResponse<RemoveUserResponseModelFromSdk>> = [];

            const inboundTags = this.internalService.getXtlsConfigInbounds();

            if (inboundTags.size === 0) {
                return ok(new RemoveUserResponseModel(true, null));
            }

            const userIps = await this.getUserIps(username);

            for (const tag of inboundTags) {
                this.logger.debug(`Removing user: ${username} from tag: ${tag}`);

                const tempRes = await this.xtlsApi.handler.removeUser(tag, username);

                await this.internalService.removeUserFromInbound(tag, hashData.vlessUuid);
                response.push(tempRes);
            }

            this.eventBus.publish(new DropConnectionsEvent(userIps));

            if (response.every((res) => !res.isOk)) {
                this.logger.error(JSON.stringify(response, null, 2));
                return ok(
                    new RemoveUserResponseModel(
                        false,
                        response.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new RemoveUserResponseModel(true, null));
        } catch (error: unknown) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        }
    }

    public async addUsers(data: AddUsersRequestDto): Promise<TResult<AddUserResponseModel>> {
        const tm = performance.now();
        try {
            const { affectedInboundTags, users } = data;

            if (this.coreState.isSingBoxActive()) {
                const mutations: ISingBoxUserMutation[] = [];
                for (const user of users) {
                    for (const inbound of user.inboundData) {
                        mutations.push({
                            tag: inbound.tag,
                            type: inbound.type,
                            name: user.userData.userId,
                            password:
                                inbound.type === 'trojan'
                                    ? user.userData.trojanPassword
                                    : inbound.type === 'shadowsocks' ||
                                        inbound.type === 'shadowsocks22'
                                      ? user.userData.ssPassword
                                      : user.userData.vlessUuid,
                            uuid: user.userData.vlessUuid,
                            ...('flow' in inbound ? { flow: inbound.flow } : {}),
                        });
                    }
                }

                await this.singBoxService.upsertUsers(
                    users.map((user) => user.userData.userId),
                    mutations,
                );

                return {
                    isOk: true,
                    response: new AddUserResponseModel(true, null),
                };
            }

            for (const tag of affectedInboundTags) {
                this.internalService.addXtlsConfigInbound(tag);
            }

            this.logger.log(
                `Adding ${users.length} users to inbounds: ${affectedInboundTags.join(', ')}`,
            );

            for (const user of users) {
                for (const tag of this.internalService.getXtlsConfigInbounds()) {
                    await this.xtlsApi.handler.removeUser(tag, user.userData.userId);

                    await this.internalService.removeUserFromInbound(tag, user.userData.hashUuid);
                }

                for (const item of user.inboundData) {
                    let tempRes = null;

                    switch (item.type) {
                        case 'trojan':
                            tempRes = await this.xtlsApi.handler.addTrojanUser({
                                tag: item.tag,
                                username: user.userData.userId,
                                password: user.userData.trojanPassword,
                                level: 0,
                            });
                            if (tempRes.isOk) {
                                await this.internalService.addUserToInbound(
                                    item.tag,
                                    user.userData.vlessUuid,
                                );
                            }

                            break;
                        case 'vless':
                            tempRes = await this.xtlsApi.handler.addVlessUser({
                                tag: item.tag,
                                username: user.userData.userId,
                                uuid: user.userData.vlessUuid,
                                flow: item.flow,
                                level: 0,
                            });
                            if (tempRes.isOk) {
                                await this.internalService.addUserToInbound(
                                    item.tag,
                                    user.userData.vlessUuid,
                                );
                            }
                            break;
                        case 'shadowsocks':
                            tempRes = await this.xtlsApi.handler.addShadowsocksUser({
                                tag: item.tag,
                                username: user.userData.userId,
                                password: user.userData.ssPassword,
                                cipherType: 0,
                                ivCheck: false,
                                level: 0,
                            });
                            if (tempRes.isOk) {
                                await this.internalService.addUserToInbound(
                                    item.tag,
                                    user.userData.vlessUuid,
                                );
                            }
                            break;
                        case 'shadowsocks22':
                            tempRes = await this.xtlsApi.handler.addShadowsocks2022User({
                                tag: item.tag,
                                username: user.userData.userId,
                                key: Buffer.from(user.userData.ssPassword).toString('base64'),
                                level: 0,
                            });
                            if (tempRes.isOk) {
                                await this.internalService.addUserToInbound(
                                    item.tag,
                                    user.userData.vlessUuid,
                                );
                            }
                            break;
                        case 'hysteria':
                            tempRes = await this.xtlsApi.handler.addHysteriaUser({
                                tag: item.tag,
                                username: user.userData.userId,
                                uuid: user.userData.vlessUuid,
                                level: 0,
                            });
                            if (tempRes.isOk) {
                                await this.internalService.addUserToInbound(
                                    item.tag,
                                    user.userData.vlessUuid,
                                );
                            }
                            break;
                        default:
                            break;
                    }
                }
            }

            return ok(new AddUserResponseModel(true, null));
        } catch (error) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        } finally {
            this.logger.log(
                'Users addition took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );
        }
    }

    public async removeUsers(
        data: RemoveUsersRequestDto,
    ): Promise<TResult<RemoveUserResponseModel>> {
        const tm = performance.now();
        try {
            const inboundTags = this.internalService.getXtlsConfigInbounds();

            if (this.coreState.isSingBoxActive()) {
                await this.singBoxService.removeUsers(data.users.map((user) => user.userId));
                return {
                    isOk: true,
                    response: new RemoveUserResponseModel(true, null),
                };
            }

            if (inboundTags.size === 0) {
                return ok(new RemoveUserResponseModel(true, null));
            }

            this.logger.log(
                `Removing ${data.users.length} users from inbounds: ${Array.from(inboundTags).join(', ')}`,
            );

            const removeUsersResponse: Array<ISdkResponse<RemoveUserResponseModelFromSdk>> = [];

            for (const user of data.users) {
                const { userId, hashUuid } = user;

                const userIps = await this.getUserIps(userId);

                for (const tag of inboundTags) {
                    this.logger.debug(`Removing user: ${userId} from tag: ${tag}`);

                    const tempRes = await this.xtlsApi.handler.removeUser(tag, userId);

                    await this.internalService.removeUserFromInbound(tag, hashUuid);
                    removeUsersResponse.push(tempRes);
                }

                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            if (removeUsersResponse.every((res) => !res.isOk)) {
                this.logger.error(JSON.stringify(removeUsersResponse, null, 2));
                return ok(
                    new RemoveUserResponseModel(
                        false,
                        removeUsersResponse.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new RemoveUserResponseModel(true, null));
        } catch (error: unknown) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        } finally {
            this.logger.log(
                'Users removal took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );
        }
    }

    public async dropUsersConnections(
        data: DropUsersConnectionsRequestDto,
    ): Promise<TResult<GenericResponseModel>> {
        try {
            const { userIds } = data;

            for (const userId of userIds) {
                const userIps = await this.getUserIps(userId);
                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            return ok(new GenericResponseModel(true));
        } catch (error) {
            this.logger.error(error);
            return ok(new GenericResponseModel(false));
        }
    }

    public async dropIps(data: DropIpsRequestDto): Promise<TResult<GenericResponseModel>> {
        try {
            const { ips } = data;

            this.eventBus.publish(new DropConnectionsEvent(ips));

            return ok(new GenericResponseModel(true));
        } catch (error) {
            this.logger.error(error);
            return ok(new GenericResponseModel(false));
        }
    }

    private async getUserIps(userId: string): Promise<string[] | null> {
        try {
            if (this.coreState.isSingBoxActive()) {
                return null;
            }

            if (!this.capNetAdminAvailable) {
                return null;
            }

            const userIps = await this.xtlsApi.stats.rawClient.getStatsOnlineIpList({
                name: `user>>>${userId}>>>online`,
                reset: true,
            });

            const ips = Object.keys(userIps.ips);

            return ips;
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 5) {
                return null;
            }

            this.logger.error(`Failed to get user IPs for user ${userId}: ${error}`);
            return null;
        }
    }

    public async removeOutbound(tag: string): Promise<void> {
        try {
            if (this.coreState.isSingBoxActive()) {
                this.logger.warn(`Dynamic outbound removal is not supported by sing-box: ${tag}`);
                return;
            }

            await this.xtlsApi.handler.rawClient.removeOutbound({
                tag,
            });

            return;
        } catch (error) {
            this.logger.error(error);
            return;
        }
    }
}
