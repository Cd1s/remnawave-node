import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { InternalModule } from '../internal/internal.module';
import { CoreStateService } from './core-state.service';
import { SingBoxProcessService } from './singbox-process.service';
import { SingBoxStatsService } from './singbox-stats.service';
import { SingBoxService } from './singbox.service';

@Global()
@Module({
    imports: [CqrsModule, InternalModule],
    providers: [CoreStateService, SingBoxProcessService, SingBoxStatsService, SingBoxService],
    exports: [CoreStateService, SingBoxService, SingBoxStatsService],
})
export class CoreModule {}
