import { z } from 'zod';

import { REST_API } from '../../api';
import { CORE_TYPE } from '../../constants';

export namespace GetNodeHealthCheckCommand {
    export const url = REST_API.XRAY.NODE_HEALTH_CHECK;

    export const ResponseSchema = z.object({
        response: z.object({
            isAlive: z.boolean(),
            xrayInternalStatusCached: z.boolean(),
            xrayVersion: z.string().nullable(),
            activeCore: z.enum([CORE_TYPE.XRAY, CORE_TYPE.SINGBOX]),
            coreVersion: z.string().nullable(),
            nodeVersion: z.string(),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
