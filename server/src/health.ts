import { NeedsLoginError } from "./auth/DocsPlusOAuthProvider.js";
import { DocsPlusError } from "./docsPlus.js";

/**
 * Health of the link to docs.plus, for GET /health/docs.
 * - Every successful docs.plus call (visitors' reads and writes) counts: if one succeeded in the last 5 minutes,
 *   nothing extra is called.
 * - Otherwise one small read (get_outline) checks it, at most once a minute however often /health/docs is polled,
 *   and concurrent checks share it. docs.plus allows 60 calls a minute for the whole app.
 */

export type DocsState = "ok" | "login_needed" | "not_owner" | "unavailable";

export interface DocsHealth {
  ok: boolean;
  docsPlus: DocsState;
  /** When docs.plus last answered successfully (ISO), if ever since start. */
  lastSuccess?: string;
}

export class Health {
  private lastSuccess?: number;
  private last?: { at: number; result: DocsHealth };
  private running?: Promise<DocsHealth>;
  private readonly now: () => number;

  constructor(
    private readonly o: {
      /** One cheap docs.plus read. */
      probe: () => Promise<unknown>;
      freshMs?: number; // a success this recent means healthy (default 5 min)
      cacheMs?: number; // how long a probe's answer is reused (default 60 s)
      now?: () => number;
    },
  ) {
    this.now = o.now ?? Date.now;
  }

  /** Called after every successful docs.plus call. */
  noteSuccess() {
    this.lastSuccess = this.now();
  }

  private view(ok: boolean, docsPlus: DocsState): DocsHealth {
    return { ok, docsPlus, ...(this.lastSuccess ? { lastSuccess: new Date(this.lastSuccess).toISOString() } : {}) };
  }

  async check(): Promise<DocsHealth> {
    const t = this.now();
    if (this.lastSuccess && t - this.lastSuccess < (this.o.freshMs ?? 5 * 60_000)) return this.view(true, "ok");
    if (this.last && t - this.last.at < (this.o.cacheMs ?? 60_000)) return this.last.result;
    this.running ??= this.probe().finally(() => (this.running = undefined));
    return this.running;
  }

  private async probe(): Promise<DocsHealth> {
    let result: DocsHealth;
    try {
      await this.o.probe();
      this.noteSuccess();
      result = this.view(true, "ok");
    } catch (err) {
      const state: DocsState = err instanceof NeedsLoginError ? "login_needed" : err instanceof DocsPlusError && err.kind === "not_owner" ? "not_owner" : "unavailable";
      console.error(`[health] docs.plus check failed (${state}): ${err instanceof Error ? err.message : err}`);
      result = this.view(false, state);
    }
    this.last = { at: this.now(), result };
    return result;
  }
}
