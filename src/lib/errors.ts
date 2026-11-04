/** Typed application errors with stable machine codes. */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  badRequest: (msg: string, details?: unknown) => new AppError(msg, "BAD_REQUEST", 400, details),
  unauthorized: (msg = "Authentication required") => new AppError(msg, "UNAUTHORIZED", 401),
  forbidden: (msg = "Not permitted") => new AppError(msg, "FORBIDDEN", 403),
  notFound: (msg = "Not found") => new AppError(msg, "NOT_FOUND", 404),
  conflict: (msg: string) => new AppError(msg, "CONFLICT", 409),
  unprocessable: (msg: string, details?: unknown) => new AppError(msg, "UNPROCESSABLE", 422, details),
  tooMany: (msg = "Rate limit exceeded") => new AppError(msg, "RATE_LIMITED", 429),
  internal: (msg = "Internal error") => new AppError(msg, "INTERNAL", 500),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
