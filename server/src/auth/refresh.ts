import { createHash } from "node:crypto";
import { discoverOAuthServerInfo, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NeedsLoginError, type DocsPlusOAuthProvider } from "./DocsPlusOAuthProvider.js";
import type { TokenStore } from "./TokenStore.js";

/**
 * docs.plus refresh tokens ROTATE: each refresh spends the token and returns a new one. If two requests
 * refresh with the same token, the second reuses a spent token, which can revoke the whole login.
 * Two layers stop that inside one process:
 *  - dedupeRefreshFetch: identical refresh requests share one network call, and a caller still holding the
 *    old token shortly afterwards gets the same answer instead of spending it again;
 *  - TokenRefresher: refreshes before expiry (single-flight), so the SDK's reactive 401 path is rarely needed.
 */

interface Buffered {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

function refreshTokenOf(init?: RequestInit): string | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "POST" || init?.body == null) return undefined;
  const body = init.body;
  const params =
    body instanceof URLSearchParams ? body : typeof body === "string" ? new URLSearchParams(body) : undefined;
  if (params?.get("grant_type") !== "refresh_token") return undefined;
  return params.get("refresh_token") ?? undefined;
}

const toResponse = (b: Buffered) => new Response(b.body.slice(0), { status: b.status, statusText: b.statusText, headers: b.headers });

export function dedupeRefreshFetch(baseFetch: FetchLike = fetch, opts: { keepMs?: number; now?: () => number; quiet?: boolean } = {}): FetchLike {
  const keepMs = opts.keepMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const inflight = new Map<string, Promise<Buffered>>();
  const done = new Map<string, { at: number; value: Buffered }>();

  return async (url, init) => {
    const token = refreshTokenOf(init);
    if (!token) return baseFetch(url, init);
    const key = createHash("sha256").update(token).digest("hex");

    for (const [k, v] of done) if (now() - v.at >= keepMs) done.delete(k);
    const recent = done.get(key);
    if (recent) return toResponse(recent.value);

    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const res = await baseFetch(url, init);
        if (!opts.quiet) console.log(`[auth] refreshed the docs.plus access token (HTTP ${res.status})`);
        const value: Buffered = { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body: await res.arrayBuffer() };
        if (res.ok) done.set(key, { at: now(), value }); // only successes are replayed; errors may be retried
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return toResponse(await p);
  };
}

/** One instance for the whole process, so every transport and the refresher share it. */
export const sharedFetch: FetchLike = dedupeRefreshFetch();

export class TokenRefresher {
  private running?: Promise<void>;

  constructor(
    private readonly o: {
      store: TokenStore;
      provider: DocsPlusOAuthProvider;
      serverUrl: string;
      fetch?: FetchLike;
      marginMs?: number;
      now?: () => number;
    },
  ) {}

  private get now() {
    return this.o.now?.() ?? Date.now();
  }

  /** Refresh if the access token expires within the margin (default 5 min). Concurrent callers share one refresh. */
  async ensureFresh(): Promise<void> {
    const t = await this.o.store.get("tokens");
    if (!t) throw new NeedsLoginError();
    if (!t.expires_in) return; // no expiry given: rely on the SDK's 401 handling
    const expiresAt = t.obtained_at + t.expires_in * 1000;
    if (expiresAt - this.now > (this.o.marginMs ?? 5 * 60_000)) return;
    this.running ??= this.refresh()
      .then(() => undefined)
      .finally(() => (this.running = undefined));
    return this.running;
  }

  /** Always refresh now (used by `pnpm token-info -- --refresh`). Returns the old and new refresh tokens. */
  async refresh(): Promise<{ before?: string; after?: string }> {
    const before = await this.o.store.get("tokens");
    if (!before?.refresh_token) throw new NeedsLoginError();
    const client = await this.o.store.get("client");
    if (!client) throw new NeedsLoginError();
    const info = (await this.o.store.get("discovery")) ?? (await discoverOAuthServerInfo(this.o.serverUrl, { fetchFn: this.o.fetch }));
    const resource = info.resourceMetadata?.resource;

    const tokens = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: client,
      refreshToken: before.refresh_token,
      resource: resource ? new URL(resource) : undefined,
      fetchFn: this.o.fetch ?? sharedFetch,
    });
    // Save straight away: the old refresh token is now spent. The SDK stamps tokens with their issuer; do the same.
    await this.o.provider.saveTokens({ ...tokens, issuer: info.authorizationServerUrl });
    return { before: before.refresh_token, after: (await this.o.store.get("tokens"))?.refresh_token };
  }
}
