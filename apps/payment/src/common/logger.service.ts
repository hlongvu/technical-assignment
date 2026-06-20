import { Global, Injectable, Module } from '@nestjs/common';
import { AppLogger, createLogger } from '@seat-reservation/be-core';
import { loadEnv } from '../config/env.js';

export const LOGGER_SERVICE = Symbol('LOGGER_SERVICE');

export interface LoggerService {
  create(component: string): AppLogger;
}

@Injectable()
class LoggerServiceImpl implements LoggerService {
  private readonly root: AppLogger;
  constructor() {
    const env = loadEnv();
    this.root = createLogger('payment', env.LOG_LEVEL);
  }
  create(component: string): AppLogger {
    return this.root.child({ component });
  }
}

@Global()
@Module({
  providers: [{ provide: LOGGER_SERVICE, useClass: LoggerServiceImpl }],
  exports: [LOGGER_SERVICE],
})
export class LoggerModule {}
