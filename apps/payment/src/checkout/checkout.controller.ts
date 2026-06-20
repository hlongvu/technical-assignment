import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PaymentIntentsRepository } from './payment-intents.repository.js';
import { MockPSPClient } from '../psps/psp.client.js';
import { CircuitBreaker } from '../psps/circuit-breaker.js';
import { JwtAuthGuard, AuthenticatedRequest } from '../common/jwt-auth.guard.js';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { Inject } from '@nestjs/common';
import { AppLogger, REQUEST_ID_HEADER, resolveTraceId } from '@seat-reservation/be-core';
import { randomUUID } from 'node:crypto';

const CheckoutDto = z.object({
  seatId: z.string().uuid(),
  holdId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});

@Injectable()
class MockPSPProvider extends MockPSPClient {
  constructor() {
    super(process.env.PSP_WEBHOOK_SECRET!);
  }
}

@Controller('api/payment')
export class CheckoutController {
  private readonly log: AppLogger;
  private readonly psp: MockPSPClient;

  constructor(
    private readonly intents: PaymentIntentsRepository,
    private readonly breaker: CircuitBreaker,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('checkout');
    this.psp = new MockPSPProvider();
  }

  /**
   * Create a payment intent. Amount is server-controlled (§3.3.3 / §5.1.5):
   * the client sends seatId/holdId/idempotencyKey only; the amount comes from
   * the local seat_prices table (DECISIONS.md #9).
   *
   * Idempotency: idempotency_key UNIQUE — duplicate request returns existing
   * intent. §3.3.4.
   */
  @Post('checkout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async checkout(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const dto = CheckoutDto.parse(body);
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);

    // Idempotency: return existing intent if same key already used.
    const existing = await this.intents.findByIdempotencyKey(dto.idempotencyKey);
    if (existing) {
      this.log.info({ action: 'checkout_idempotent', intentId: existing.id, traceId }, 'checkout idempotent reuse');
      return {
        intentId: existing.id,
        clientSecret: existing.client_secret,
        amountCents: existing.amount_cents,
        currency: existing.currency,
        idempotent: true,
      };
    }

    // Server-controlled amount. Look up from local cache table (DECISIONS.md #9).
    const price = await this.intents.getSeatPrice(dto.seatId);
    if (!price) {
      throw new BadRequestException({ error: 'seat_price_unknown', seatId: dto.seatId });
    }

    // Call PSP through circuit breaker + timeout. §4.4.3.
    let pspResult;
    try {
      pspResult = await this.breaker.exec(() =>
        this.psp.createIntent({
          amountCents: price.price_cents,
          currency: price.currency,
          idempotencyKey: dto.idempotencyKey,
          metadata: { seatId: dto.seatId, userId: req.user.userId, holdId: dto.holdId, traceId },
        }),
      );
    } catch (e) {
      this.log.error({ action: 'psp_create_failed', err: String(e), traceId }, 'PSP createIntent failed');
      throw new BadRequestException({ error: 'psp_unavailable', detail: String(e) });
    }

    const intent = await this.intents.createIntent({
      seatId: dto.seatId,
      userId: req.user.userId,
      holdId: dto.holdId,
      amountCents: price.price_cents,
      currency: price.currency,
      idempotencyKey: dto.idempotencyKey,
      pspIntentId: pspResult.pspIntentId,
      clientSecret: pspResult.clientSecret,
    });

    this.log.info(
      { action: 'payment_initiate', intentId: intent.id, seatId: dto.seatId, userId: req.user.userId, amountCents: intent.amount_cents, traceId },
      'payment intent created',
    );

    return {
      intentId: intent.id,
      clientSecret: intent.client_secret,
      amountCents: intent.amount_cents,
      currency: intent.currency,
      idempotent: false,
    };
  }
}
