import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * In-process event bus for SSE fan-out.
 *
 * TODO(prod): Replace with Redis pub/sub so multiple seat-service instances
 * fan-out consistently. In-process bus only works for single replica.
 * See DECISIONS.md #7. The SSE endpoint shape stays identical — only the
 * transport changes.
 */
@Injectable()
export class SeatEventBus {
  private readonly emitter = new EventEmitter();
  public readonly CHANNEL = 'seat:changed';

  emit(payload: unknown): void {
    this.emitter.emit(this.CHANNEL, payload);
  }

  on(listener: (payload: unknown) => void): () => void {
    this.emitter.on(this.CHANNEL, listener);
    return () => this.emitter.off(this.CHANNEL, listener);
  }
}
