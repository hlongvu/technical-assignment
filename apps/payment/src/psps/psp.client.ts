import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payment Service Provider client boundary. Checklist §5.1.1.
 *
 * `MockPSPClient` is the only implementation; a real `StripeClient` would
 * implement the same interface (wrapping stripe.webhooks.constructEvent).
 * See DECISIONS.md #3.
 */

export interface CreateIntentOpts {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface CreateIntentResult {
  pspIntentId: string;
  clientSecret: string;
}

export interface PSPWebhookEvent {
  id: string;            // stripe_event_id equivalent
  type: string;          // 'payment_intent.succeeded' | 'payment_intent.payment_failed'
  created: number;       // unix seconds
  data: {
    object: {
      id: string;             // psp_intent_id
      amount: number;         // cents
      metadata: Record<string, string>;
    };
  };
}

export interface PSPClient {
  createIntent(opts: CreateIntentOpts): Promise<CreateIntentResult>;
  /** Verify HMAC signature + parse event. Throws on bad signature. */
  constructEventFromWebhook(rawBody: Buffer, signature: string): PSPWebhookEvent;
}

export class MockPSPClient implements PSPClient {
  private readonly webhookSecret: string;

  constructor(webhookSecret: string) {
    this.webhookSecret = webhookSecret;
  }

  async createIntent(opts: CreateIntentOpts): Promise<CreateIntentResult> {
    const pspIntentId = `pi_mock_${opts.idempotencyKey}`;
    const clientSecret = `${pspIntentId}_secret_${Math.random().toString(36).slice(2)}`;
    return { pspIntentId, clientSecret };
  }

  /**
   * Verify webhook HMAC-SHA256. Checklist §5.1.2.
   * Format: t=<unix>,v1=<hex-hmac>
   * Same algorithm Stripe uses; real Stripe SDK wraps this.
   */
  constructEventFromWebhook(rawBody: Buffer, signature: string): PSPWebhookEvent {
    const parts = signature.split(',').map((p) => p.trim());
    let t: string | undefined;
    let v1: string | undefined;
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (k === 't') t = v;
      if (k === 'v1') v1 = v;
    }
    if (!t || !v1) throw new Error('malformed_signature');

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${t}.${rawBody.toString('utf8')}`)
      .digest('hex');

    // Timing-safe compare. Checklist §5.1.2 Exceed.
    const a = Buffer.from(v1, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('invalid_signature');
    }
    // Parse the event body (rawBody is the JSON payload).
    const parsed = JSON.parse(rawBody.toString('utf8')) as PSPWebhookEvent;
    // Sanity-check timestamp field exists.
    if (typeof parsed.created !== 'number') throw new Error('missing_created');
    return parsed;
  }
}
