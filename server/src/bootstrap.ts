import type { AuthRecords, StoredTokens, TokenStore } from "./auth/TokenStore.js";

/** Everything a server needs to act as the doc owner: one docs.plus session. As secret as the tokens themselves. */
export interface LoginBundle {
  v: 1;
  client: AuthRecords["client"];
  tokens: StoredTokens;
  discovery?: AuthRecords["discovery"];
}

export function encodeBundle(b: LoginBundle): string {
  return Buffer.from(JSON.stringify(b)).toString("base64");
}

export function decodeBundle(text: string): LoginBundle {
  let b: Partial<LoginBundle>;
  try {
    b = JSON.parse(Buffer.from(text.trim(), "base64").toString("utf8")) as Partial<LoginBundle>;
  } catch {
    throw new Error("DOCSPLUS_LOGIN_BUNDLE is not a valid bundle (create it with `pnpm export-login`).");
  }
  const t = b?.tokens;
  if (b?.v !== 1 || typeof b.client?.client_id !== "string" || typeof t?.access_token !== "string" || typeof t?.refresh_token !== "string" || typeof t?.obtained_at !== "number") {
    throw new Error("DOCSPLUS_LOGIN_BUNDLE is incomplete (create it with `pnpm export-login`).");
  }
  return b as LoginBundle;
}

export async function exportBundle(store: TokenStore): Promise<LoginBundle> {
  const [client, tokens, discovery] = await Promise.all([store.get("client"), store.get("tokens"), store.get("discovery")]);
  if (!client || !tokens?.refresh_token) throw new Error("No complete login in this SECRETS_DIR. Run `pnpm run login` first.");
  return { v: 1, client, tokens, ...(discovery ? { discovery } : {}) };
}

/**
 * At server start: import the login from DOCSPLUS_LOGIN_BUNDLE, but ONLY into an empty store.
 * Once the server has refreshed, the bundle's refresh token is spent, so re-importing it would break the login.
 */
export async function bootstrapLogin(store: TokenStore, bundleText: string | undefined, log: Pick<Console, "log" | "warn"> = console) {
  const has = !!(await store.get("tokens"));
  if (!bundleText?.trim()) return has ? "existing" : "none";
  if (has) {
    log.warn("[bootstrap] DOCSPLUS_LOGIN_BUNDLE is still set, but a login already exists. It was NOT imported. Delete the variable.");
    return "existing";
  }
  const b = decodeBundle(bundleText);
  await store.set("client", b.client);
  if (b.discovery) await store.set("discovery", b.discovery);
  await store.set("tokens", b.tokens); // last, so a half-finished import still counts as "no login"
  log.log("[bootstrap] Imported the docs.plus login from DOCSPLUS_LOGIN_BUNDLE. Now DELETE that variable from the host.");
  return "imported";
}
