import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DocsPlusOAuthProvider, type ProviderOptions } from "./auth/DocsPlusOAuthProvider.js";
import { sharedFetch } from "./auth/refresh.js";
import { FileTokenStore } from "./auth/FileTokenStore.js";
import type { TokenStore } from "./auth/TokenStore.js";
import { config } from "./config.js";
import { serverLockHeld } from "./instanceLock.js";
import path from "node:path";

export function defaultStore(): TokenStore {
  // Later: TOKEN_STORE=redis selects RedisTokenStore.
  return new FileTokenStore(config.secretsDir);
}

export function makeProvider(store: TokenStore, onRedirect?: ProviderOptions["onRedirect"]) {
  return new DocsPlusOAuthProvider({ store, redirectUrl: config.redirectUrl, onRedirect });
}

/**
 * Server-side only. docs.plus returns 403 for requests with a browser Origin header, and Node's fetch sends none.
 * Without onRedirect, a missing or expired login throws NeedsLoginError instead of opening a browser.
 */
export function makeTransport(provider: DocsPlusOAuthProvider) {
  // sharedFetch de-duplicates refresh-token requests across all transports in this process (see auth/refresh.ts).
  return new StreamableHTTPClientTransport(new URL(config.mcpUrl), { authProvider: provider, fetch: sharedFetch });
}

/**
 * Scripts (check, write-test, …) warn if a server is running on the same login: two processes refreshing the
 * same rotating token can break it. The server itself passes { fromServer: true }.
 */
export async function connect(provider: DocsPlusOAuthProvider, opts: { fromServer?: boolean } = {}) {
  if (!opts.fromServer) {
    const held = await serverLockHeld(path.join(config.secretsDir, "server.lock")).catch(() => undefined);
    if (held && held.pid !== process.pid) {
      console.warn(`[warn] A server (pid ${held.pid}) is using this login. Stop it before running scripts, or a token refresh could break the login.`);
    }
  }
  const transport = makeTransport(provider);
  const client = new Client({ name: "ration-club-recipes", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}
