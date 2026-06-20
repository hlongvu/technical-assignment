import { Injectable, OnModuleDestroy } from '@nestjs/common';
import amqp, { type ChannelModel, type Channel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { loadEnv } from '../config/env.js';
import { EXCHANGES, QUEUES, ROUTING_KEYS } from '@seat-reservation/contracts';

/**
 * Thin RabbitMQ wrapper. Single connection, single publishing confirm channel,
 * per-consumer channels. Reconnect-on-close TODO(prod): use amqp-connection-manager.
 */
@Injectable()
export class RabbitService implements OnModuleDestroy {
  private conn: ChannelModel | null = null;
  private pubChannel: ConfirmChannel | null = null;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.conn) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    await this.connecting;
  }

  private async doConnect(): Promise<void> {
    const env = loadEnv();
    for (let attempt = 1; ; attempt++) {
      try {
        this.conn = await amqp.connect(env.RABBITMQ_URL);
        break;
      } catch (e) {
        if (attempt >= 10) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    // Confirm channel for publisher confirms (at-least-once to broker).
    this.pubChannel = await this.conn.createConfirmChannel();
    await this.pubChannel.assertExchange(EXCHANGES.SEAT_EVENTS, 'topic', { durable: true });
    await this.pubChannel.assertExchange(EXCHANGES.PAYMENT_EVENTS, 'topic', { durable: true });
    await this.pubChannel.assertExchange(`${EXCHANGES.PAYMENT_EVENTS}.dlx`, 'topic', { durable: true });

    // Set up our consuming queue (payment events that seat-service consumes).
    const setup = await this.conn.createChannel();
    await setup.assertQueue(QUEUES.SEAT_PAYMENT_EVENTS, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': `${EXCHANGES.PAYMENT_EVENTS}.dlx` },
    });
    await setup.bindQueue(QUEUES.SEAT_PAYMENT_EVENTS, EXCHANGES.PAYMENT_EVENTS, ROUTING_KEYS.PAYMENT_SUCCEEDED);
    await setup.bindQueue(QUEUES.SEAT_PAYMENT_EVENTS, EXCHANGES.PAYMENT_EVENTS, ROUTING_KEYS.PAYMENT_FAILED);
    await setup.assertQueue(`${QUEUES.SEAT_PAYMENT_EVENTS}.dlq`, { durable: true });
    await setup.bindQueue(`${QUEUES.SEAT_PAYMENT_EVENTS}.dlq`, `${EXCHANGES.PAYMENT_EVENTS}.dlx`, '#');
    await setup.close();
  }

  /** Publish with publisher confirms. Returns true on ack. */
  async publish(
    exchange: string,
    routingKey: string,
    payload: Buffer,
    headers: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.pubChannel) await this.connect();
    return new Promise((resolve) => {
      this.pubChannel!.publish(exchange, routingKey, payload, {
        persistent: true,
        headers,
        contentType: 'application/json',
      });
      this.pubChannel!.waitForConfirms()
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
  }

  /** Subscribe to a queue. */
  async consume(
    queue: string,
    handler: (msg: ConsumeMessage | null, channel: Channel) => Promise<void>,
  ): Promise<void> {
    if (!this.conn) await this.connect();
    const ch = await this.conn!.createChannel();
    await ch.prefetch(10);
    await ch.consume(queue, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        await handler(msg, ch);
      } catch (e) {
        ch.nack(msg, false, true);
      }
    }, { noAck: false });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.pubChannel) await this.pubChannel.close();
      if (this.conn) await this.conn.close();
    } catch { /* ignore */ }
  }
}
