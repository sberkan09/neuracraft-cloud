import type { ErrorCode } from "@neuracraft/shared";

// Thrown by handlers; the error handler turns it into {error: {code, params}} with the status.
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly params?: Record<string, string | number>,
  ) {
    super(code);
  }
}

export const fail = (status: number, code: ErrorCode, params?: Record<string, string | number>): never => {
  throw new ApiFailure(status, code, params);
};
