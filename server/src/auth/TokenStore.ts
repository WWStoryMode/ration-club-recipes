import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

/** Tokens plus the time we received them, so expiry can be computed from expires_in. */
export interface StoredTokens extends OAuthTokens {
  obtained_at: number; // epoch ms
}

/** Everything the OAuth flow persists. Each key is stored and cleared independently. */
export interface AuthRecords {
  client: OAuthClientInformationMixed; // dynamic client registration result
  tokens: StoredTokens;
  verifier: string; // PKCE code_verifier for an in-flight login
  state: string; // OAuth state for an in-flight login (CSRF check in the callback)
  discovery: OAuthDiscoveryState; // cached server/AS metadata
}
export type AuthKey = keyof AuthRecords;

/**
 * Storage behind the OAuth provider. FileTokenStore (local dev) now, RedisTokenStore (serverless) later.
 * Everything here is secret: the refresh token can act as the doc owner on docs.plus.
 */
export interface TokenStore {
  get<K extends AuthKey>(key: K): Promise<AuthRecords[K] | undefined>;
  set<K extends AuthKey>(key: K, value: AuthRecords[K]): Promise<void>;
  delete(...keys: AuthKey[]): Promise<void>;
}
