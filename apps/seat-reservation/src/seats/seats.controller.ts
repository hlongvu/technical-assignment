import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SeatsRepository } from './seats.repository.js';
import { HoldsRepository } from '../holds/holds.repository.js';
import { SeatEventBus } from './seat-event.bus.js';
import { JwtAuthGuard, AuthenticatedRequest } from '../common/jwt-auth.guard.js';
import { RateLimit } from '../common/rate-limit.guard.js';
import { loadEnv } from '../config/env.js';
import { REQUEST_ID_HEADER, resolveTraceId } from '@seat-reservation/be-core';
import { seatsHeldTotal, seatsReleasedTotal, holdConflictsTotal } from '../metrics/metrics.controller.js';

const HoldBodySchema = z.object({}).strip();

@Controller('api/seats')
export class SeatsController {
  constructor(
    private readonly seats: SeatsRepository,
    private readonly holds: HoldsRepository,
    private readonly bus: SeatEventBus,
  ) {}

  /** Public list of seats with current state. */
  @Get()
  async list() {
    const seats = await this.seats.listAll();
    return { seats };
  }

  /**
   * SSE endpoint for live seat updates. Checklist §3.2.3 / §4.4.1.
   * In-process EventEmitter — see DECISIONS.md #7 for TODO(prod) Redis pub/sub.
   */
  @Sse('stream')
  stream(): Observable<{ data: unknown }> {
    return new Observable<unknown>((subscriber) => {
      // Send an initial ping so the client knows the stream is alive.
      subscriber.next({ type: 'hello', at: new Date().toISOString() });
      const off = this.bus.on((payload) => subscriber.next(payload));
      // Heartbeat every 25s to keep proxies from closing the connection.
      const hb = setInterval(() => subscriber.next({ type: 'ping', at: new Date().toISOString() }), 25000);
      return () => { off(); clearInterval(hb); };
    }).pipe(map((data) => ({ data })));
  }

  /**
   * Hold a seat. Atomic, SERIALIZABLE, with DB-level unique invariants.
   * Checklist §3.1.1–§3.1.5. DECISIONS.md #2.
   */
  @Post(':id/hold')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @RateLimit({
    name: 'seat-hold',
    windowMs: loadEnv().RATE_LIMIT_SEAT_WINDOW_MS,
    max: loadEnv().RATE_LIMIT_SEAT_MAX,
  })
  async hold(
    @Param('id') seatId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    HoldBodySchema.parse(body);
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const result = await this.holds.insertHoldTx(seatId, req.user.userId, traceId);
    if (!result.ok) {
      holdConflictsTotal.inc();
      // Checklist §3.1.5: 409 + meaningful Retry-After.
      res.setHeader('Retry-After', String(loadEnv().RETRY_AFTER_SECONDS));
      throw new ConflictException({
        error: result.reason === 'user_has_hold' ? 'user_already_has_hold' : 'seat_unavailable',
        retryAfter: loadEnv().RETRY_AFTER_SECONDS,
      });
    }
    seatsHeldTotal.inc();
    this.bus.emit({ type: 'seat:held', seatId, userId: req.user.userId, heldUntil: result.hold.held_until });
    return {
      holdId: result.hold.id,
      seatId,
      heldUntil: result.hold.held_until.toISOString(),
      priceCents: (await this.seats.getPrice(seatId))?.price_cents,
    };
  }

  /** Release the current user's hold (user cancellation). */
  @Post(':id/release')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @RateLimit({
    name: 'seat-release',
    windowMs: loadEnv().RATE_LIMIT_SEAT_WINDOW_MS,
    max: loadEnv().RATE_LIMIT_SEAT_MAX,
  })
  async release(@Param('id') seatId: string, @Req() req: AuthenticatedRequest) {
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const hold = await this.holds.findActiveHoldForSeat(seatId);
    if (!hold || hold.user_id !== req.user.userId) return;
    const { released, seatId: sid } = await this.holds.releaseHold(hold.id, 'user_cancelled', traceId);
    if (released) {
      seatsReleasedTotal.inc();
      this.bus.emit({ type: 'seat:released', seatId: sid });
    }
  }
}
