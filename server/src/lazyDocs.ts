import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NeedsLoginError } from "./auth/DocsPlusOAuthProvider.js";
import { sharedFetch, TokenRefresher } from "./auth/refresh.js";
import type { TokenStore } from "./auth/TokenStore.js";
import { config } from "./config.js";
import { DocsPlus, DocsPlusError } from "./docsPlus.js";
import { connect as realConnect, defaultStore, makeProvider } from "./mcp.js";
import type { DocsPort } from "./recipes.js";

type Connect = () => Promise<{ client: Client; dp: DocsPort }>;

/** docs.plus answered 401: it did NOT run the call, so retrying (even a write) is safe. */
export function isUnauthorized(err: unknown): boolean {
  return (err instanceof StreamableHTTPError && err.code === 401) || err instanceof UnauthorizedError;
}

/**
 * The server's connection to docs.plus.
 * - Connects on first use (non-interactive: a missing login throws NeedsLoginError) and reuses the connection.
 * - Refreshes the access token BEFORE it expires (TokenRefresher), so concurrent requests don't race the SDK's
 *   own 401-triggered refresh.
 * - A 401-type failure is retried once on the same connection. Any other non-docs.plus failure (network,
 *   transport) drops the connection so the next call reconnects.
 */
export class LazyDocs implements DocsPort {
  private conn?: Promise<{ client: Client; dp: DocsPort }>;
  private readonly connectFn: Connect;
  private readonly refresher?: Pick<TokenRefresher, "ensureFresh">;

  constructor(
    slug: string,
    opts: { connect?: Connect; refresher?: Pick<TokenRefresher, "ensureFresh"> | null; store?: TokenStore } = {},
  ) {
    const store = opts.store ?? defaultStore();
    const provider = makeProvider(store);
    this.connectFn =
      opts.connect ??
      (async () => {
        const { client } = await realConnect(provider, { fromServer: true });
        return { client, dp: new DocsPlus(client, slug) };
      });
    this.refresher =
      opts.refresher === null ? undefined : (opts.refresher ?? new TokenRefresher({ store, provider, serverUrl: config.mcpUrl, fetch: sharedFetch }));
  }

  private get() {
    this.conn ??= this.connectFn();
    return this.conn;
  }

  private drop() {
    const old = this.conn;
    this.conn = undefined;
    old?.then(({ client }) => client.close()).catch(() => {});
  }

  private async run<T>(fn: (dp: DocsPort) => Promise<T>): Promise<T> {
    await this.refresher?.ensureFresh();
    try {
      return await fn((await this.get()).dp);
    } catch (err) {
      if (isUnauthorized(err)) {
        try {
          return await fn((await this.get()).dp);
        } catch (again) {
          if (isUnauthorized(again)) throw new NeedsLoginError();
          if (!(again instanceof DocsPlusError)) this.drop();
          throw again;
        }
      }
      if (!(err instanceof DocsPlusError) && !(err instanceof NeedsLoginError)) this.drop();
      throw err;
    }
  }

  getOutline: DocsPort["getOutline"] = () => this.run((dp) => dp.getOutline());
  readSection: DocsPort["readSection"] = (id) => this.run((dp) => dp.readSection(id));
  editBlocks: DocsPort["editBlocks"] = (p) => this.run((dp) => dp.editBlocks(p));
  appendRecipe: DocsPort["appendRecipe"] = (t, b, l) => this.run((dp) => dp.appendRecipe(t, b, l));
}
