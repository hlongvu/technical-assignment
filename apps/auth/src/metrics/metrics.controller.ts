import { Controller, Get } from '@nestjs/common';
import promClient from 'prom-client';

// Checklist §4.3.3 / §4.3.4
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Business counters
export const loginSuccessTotal = new promClient.Counter({
  name: 'auth_login_success_total',
  help: 'Total successful logins',
  registers: [register],
});
export const loginFailTotal = new promClient.Counter({
  name: 'auth_login_fail_total',
  help: 'Total failed logins',
  registers: [register],
});
export const refreshTotal = new promClient.Counter({
  name: 'auth_refresh_total',
  help: 'Total refresh-token rotations',
  registers: [register],
});
export const reuseDetectedTotal = new promClient.Counter({
  name: 'auth_reuse_detected_total',
  help: 'Refresh-token reuse (theft) detections',
  registers: [register],
});

@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
