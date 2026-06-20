import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookReprocessor } from './webhook-reprocessor.js';
import { CheckoutModule } from '../checkout/checkout.module.js';

@Module({
  imports: [CheckoutModule],
  controllers: [WebhooksController],
  providers: [WebhookReprocessor],
})
export class WebhooksModule {}
