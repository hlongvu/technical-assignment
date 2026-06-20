import { Injectable } from '@nestjs/common';
import { loadEnv } from '../config/env.js';

/**
 * Hand-rolled circuit breaker with open/half-open/closed states. §4.4.3.
 * TODO(prod): tune thresholds per PSP SLA; consider `opossum` library.
 */
type State = 'closed' | 'open' | 'half_open';

@Injectable()
export class CircuitBreaker {
  private state: State = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor() {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const env = loadEnv();
    if (this.state === 'open') {
      if (Date.now() - this.openedAt > env.PSP_CB_RESET_MS) {
        this.state = 'half_open';
      } else {
        throw new Error('circuit_open');
      }
    }
    try {
      const result = await withTimeout(fn(), env.PSP_TIMEOUT_MS);
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (e) {
      this.failures++;
      if (this.failures * 2 >= env.PSP_CB_ERROR_THRESHOLD) {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      throw e;
    }
  }

  get currentState(): State { return this.state; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('psp_timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
