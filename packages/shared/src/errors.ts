// Error codes the API returns as {error: {code, params}}. The web turns each into a sentence in the
// user's language (apps/web/src/locales/<lang>.json, key "errors.<code>"); add the key there for
// every new code.
export const ErrorCodes = [
  "auth.required",
  "auth.invalid_credentials",
  "auth.email_taken",
  "auth.weak_password",
  "auth.invalid_email",
  "auth.token_revoked",
  "auth.token_expired",
  "auth.scope_missing",
  "request.invalid",
  "request.too_large",
  "rate_limited",
  "not_found",
  "forbidden",
  "workflow.invalid",
  "workflow.asset_missing",
  "workflow.path_not_allowed",
  "limit.steps",
  "limit.pixels",
  "limit.frames",
  "limit.denoise_steps",
  "limit.time",
  "limit.concurrent_jobs",
  "credits.insufficient",
  "job.not_cancellable",
  "job.failed",
  "job.no_3d_worker",
  "preset.unknown",
  "preset.params_invalid",
  "preset.unavailable",
  "content.text_refused",
  "content.flagged",
  "content.unchecked",
  "report.invalid",
  "worker.unauthorized",
  "worker.lease_lost",
  "model.unsupported",
  "internal",
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

export interface ApiError {
  error: { code: ErrorCode; params?: Record<string, string | number> };
}
