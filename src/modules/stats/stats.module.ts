import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CoreModule } from '../core/core.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
@Module({
    imports: [CqrsModule, CoreModule],
    providers: [StatsService],
    controllers: [StatsController],
})
export class StatsModule {}
