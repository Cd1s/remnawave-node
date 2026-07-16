import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CoreModule } from '../core/core.module';
import { COMMANDS } from './commands';
import { HandlerController } from './handler.controller';
import { HandlerService } from './handler.service';
@Module({
    imports: [CqrsModule, CoreModule],
    controllers: [HandlerController],
    providers: [HandlerService, ...COMMANDS],
})
export class HandlerModule {}
