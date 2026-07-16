import { Injectable } from '@nestjs/common';

import { CORE_TYPE, TCoreType } from '@libs/contracts/constants';

@Injectable()
export class CoreStateService {
    private activeCore: TCoreType = CORE_TYPE.XRAY;
    private online = false;
    private version: string | null = null;

    public setActiveCore(coreType: TCoreType, online: boolean, version: string | null): void {
        this.activeCore = coreType;
        this.online = online;
        this.version = version;
    }

    public setOffline(coreType?: TCoreType): void {
        if (coreType && this.activeCore !== coreType) return;
        this.online = false;
    }

    public getActiveCore(): TCoreType {
        return this.activeCore;
    }

    public getVersion(): string | null {
        return this.version;
    }

    public isOnline(): boolean {
        return this.online;
    }

    public isSingBoxActive(): boolean {
        return this.activeCore === CORE_TYPE.SINGBOX && this.online;
    }
}
