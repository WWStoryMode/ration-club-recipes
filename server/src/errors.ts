import { NeedsLoginError } from "./auth/DocsPlusOAuthProvider.js";
import { DocsPlusError } from "./docsPlus.js";

export type ApiErrorCode = "invalid" | "not_found" | "conflict" | "rate_limited" | "unconfirmed" | "unavailable" | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  invalid: 422,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unconfirmed: 503,
  unavailable: 503,
  internal: 500,
};

/** An error with a plain-language message that is safe to show visitors. */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = STATUS[code];
  }
}

export const MESSAGES = {
  conflict: "Someone else changed this recipe while you were editing. Here is the latest version: copy your changes, reload and try again.",
  stale: "Someone else is changing this recipe right now. Reload to see the latest version, then try again.",
  rateLimited: "The booklet is getting a lot of changes right now. Please wait a minute and try again.",
  unconfirmed: "We couldn't confirm your change was saved. Please wait a minute and reload before trying again, so it isn't saved twice.",
  unavailable: "The recipe booklet isn't available right now. Please try again later.",
  internal: "Something went wrong on our side. Please try again in a moment.",
  media: "Pictures and videos can only be changed by the booklet's organisers.",
  rejected: "docs.plus couldn't accept this change. Please check the text and try again.",
};

/** Map anything thrown while serving a request to an ApiError. Logs the real cause server-side only. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof NeedsLoginError) {
    console.error("[docs.plus] login needed:", err.message);
    return new ApiError("unavailable", MESSAGES.unavailable);
  }
  if (err instanceof DocsPlusError) {
    switch (err.kind) {
      case "stale_rev":
        return new ApiError("conflict", MESSAGES.stale);
      case "rate_limited":
        return new ApiError("rate_limited", MESSAGES.rateLimited);
      case "unconfirmed_write":
        console.error(`[docs.plus] ${err.tool}: write not confirmed`);
        return new ApiError("unconfirmed", MESSAGES.unconfirmed);
      case "invalid_input":
        console.warn(`[docs.plus] ${err.tool} refused input: ${err.message}`);
        return new ApiError("invalid", /picture, video or file/.test(err.message) ? MESSAGES.media : MESSAGES.rejected);
      case "not_owner":
        console.error(`[docs.plus] ${err.tool}: not owner. Is DOC_SLUG owned by the signed-in account?`);
        return new ApiError("unavailable", MESSAGES.unavailable);
      default:
        console.error(`[docs.plus] ${err.tool} failed: ${err.message}`);
        return new ApiError("internal", MESSAGES.internal);
    }
  }
  console.error("[api] unexpected error:", err);
  return new ApiError("internal", MESSAGES.internal);
}
