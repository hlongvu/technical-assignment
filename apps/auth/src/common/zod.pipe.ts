import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodError, type ZodTypeAny } from 'zod';

/**
 * Generic Zod validation pipe. Use as `@Body(new ZodPipe(LoginDto))`.
 * Checklist §1.1.7: input validation at API boundary, strip unknown fields.
 */
@Injectable()
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (e) {
      if (e instanceof ZodError) {
        throw new BadRequestException({
          error: 'validation_failed',
          issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      throw e;
    }
  }
}
