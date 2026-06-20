import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { CheckoutModule } from '../checkout/checkout.module.js';

@Module({
  imports: [CheckoutModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
