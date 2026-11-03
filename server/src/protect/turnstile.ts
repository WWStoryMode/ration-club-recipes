import { ApiError } from "../errors.js";

/** Checks that a write comes from a person. Turnstile in production; nothing in tests or when explicitly disabled. */
export interface HumanCheck {
  readonly siteKey: string | null;
  verify(token: string | undefined, ip: string): Promise<void>;
}

export const noHumanCheck: HumanCheck = { siteKey: null, verify: async () => {} };

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const HUMAN_MESSAGES = {
  missing: "Please complete the check that you're human, then try again.",
  failed: "The human check failed or expired. Please complete it again and resubmit.",
  unavailable: "We couldn't confirm you're human just now. Please try again in a minute.",
};

/**
 * Cloudflare Turnstile server-side check (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
 * Tokens are single-use and expire after 5 minutes; Cloudflare enforces both.
 * Test keys: secret 1x0000000000000000000000000000000AA always passes, 2x0000000000000000000000000000000AA always fails.
 */
export class Turnstile implements HumanCheck {
  constructor(
    private readonly o: {
      secret: string;
      siteKey: string | null;
      /** If set, the token must have been issued on one of these hostnames (your site). */
      hostnames?: string[];
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  get siteKey() {
    return this.o.siteKey;
  }

  async verify(token: string | undefined, ip: string): Promise<void> {
    if (!token?.trim()) throw new ApiError("invalid", HUMAN_MESSAGES.missing, { reason: "turnstile_missing" });
    if (token.length > 2048) throw new ApiError("invalid", HUMAN_MESSAGES.failed, { reason: "turnstile_invalid" });

    const body = new URLSearchParams({ secret: this.o.secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    let data: { success?: boolean; hostname?: string; "error-codes"?: string[] };
    try {
      const res = await (this.o.fetch ?? fetch)(VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000) });
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.error("[turnstile] verification request failed:", err instanceof Error ? err.message : err);
      throw new ApiError("unavailable", HUMAN_MESSAGES.unavailable, { reason: "turnstile_unreachable" });
    }
    if (!data.success) {
      throw new ApiError("invalid", HUMAN_MESSAGES.failed, { reason: `turnstile_failed:${(data["error-codes"] ?? []).join(",")}` });
    }
    if (this.o.hostnames?.length && !this.o.hostnames.includes(data.hostname ?? "")) {
      console.warn(`[turnstile] token was issued for hostname "${data.hostname}", not ${this.o.hostnames.join(", ")}`);
      throw new ApiError("invalid", HUMAN_MESSAGES.failed, { reason: "turnstile_hostname" });
    }
  }
}
