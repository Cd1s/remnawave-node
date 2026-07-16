import { TCoreType } from '@libs/contracts/constants';

export class GetNodeHealthCheckResponseModel {
    public isAlive: boolean;
    public xrayInternalStatusCached: boolean;
    public xrayVersion: null | string;
    public activeCore: TCoreType;
    public coreVersion: null | string;
    public nodeVersion: string;
    constructor(
        isAlive: boolean,
        xrayInternalStatusCached: boolean,
        xrayVersion: null | string,
        activeCore: TCoreType,
        coreVersion: null | string,
        nodeVersion: string,
    ) {
        this.isAlive = isAlive;
        this.xrayInternalStatusCached = xrayInternalStatusCached;
        this.xrayVersion = xrayVersion;
        this.activeCore = activeCore;
        this.coreVersion = coreVersion;
        this.nodeVersion = nodeVersion;
    }
}
