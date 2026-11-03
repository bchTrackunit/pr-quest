import { z } from 'zod';

import { ApiError } from './router.ts';

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/-]+$/, 'Model ids may only contain letters, digits and . : / - _');

/** A missing body counts as `{}`. Failures name the field but never echo the value. */
export function parseBody<TBody>(schema: z.ZodType<TBody>, body: unknown): TBody {
  return parseOrReject(schema, body ?? {}, 'Invalid request body');
}

export function parseOrReject<TValue>(
  schema: z.ZodType<TValue>,
  value: unknown,
  fallbackMessage: string,
): TValue {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(400, 'badRequest', `${where}${issue?.message ?? fallbackMessage}`);
  }
  return parsed.data;
}
