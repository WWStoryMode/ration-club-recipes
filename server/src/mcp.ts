import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DocsPlusOAuthProvider, type ProviderOptions } from "./auth/DocsPlusOAuthProvider.js";
import { FileTokenStore } from "./auth/FileTokenStore.js";
import type { TokenStore } from "./auth/TokenStore.js";
import { config } from "./config.js";

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
  return new StreamableHTTPClientTransport(new URL(config.mcpUrl), { authProvider: provider });
}

export async function connect(provider: DocsPlusOAuthProvider) {
  const transport = makeTransport(provider);
  const client = new Client({ name: "ration-club-recipes", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}
