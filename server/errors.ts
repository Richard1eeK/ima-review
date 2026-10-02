export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST', public current?: unknown) { super(message); }
}
export function assert(condition: unknown, message: string, status = 400, code = 'INVALID_REQUEST'): asserts condition {
  if (!condition) throw new AppError(message, status, code);
}
