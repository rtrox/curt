import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Throw this anywhere; index.ts renders it as {"error":{"code","message"}}. */
export class ApiError extends HTTPException {
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(status, { message });
    this.code = code;
  }
}
