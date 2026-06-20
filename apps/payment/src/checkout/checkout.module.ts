import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { PaymentIntentsRepository } from './payment-intents.repository.js';
import { CircuitBreaker } from '../psps/circuit-breaker.js';

@Module({
  controllers: [CheckoutController],
  providers: [PaymentIntentsRepository, CircuitBreaker],
  exports: [PaymentIntentsRepository],
})
export class CheckoutModule {}
