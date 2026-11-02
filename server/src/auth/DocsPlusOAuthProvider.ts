import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TokenStore } from "./TokenStore.js";

/** Thrown when a non-interactive process (the API server) needs a human to run `pnpm login`. */
export class NeedsLoginError extends Error {
  constructor() {
    super("docs.plus authorization is missing or expired. Run `pnpm login` on a machine with a browser.");
    this.name = "NeedsLoginError";
  }
}

export interface ProviderOptions {
  store: TokenStore;
  redirectUrl: string; // e.g. http://localhost:8787/callback
  /** Interactive (pnpm login) opens the browser. Non-interactive (server) throws NeedsLoginError instead. */
  onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
}

export class DocsPlusOAuthProvider implements OAuthClientProvider {
  constructor(private readonly opts: ProviderOptions) {}

  get redirectUrl() {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Ration Club Recipes",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email profile",
    };
  }

  async state(): Promise<string> {
    const s = randomBytes(24).toString("base64url");
    await this.opts.store.set("state", s);
    return s;
  }

  clientInformation() {
    return this.opts.store.get("client");
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    await this.opts.store.set("client", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const t = await this.opts.store.get("tokens");
    if (!t) return undefined;
    const { obtained_at: _ignored, ...tokens } = t;
    return tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    // A refresh response may omit refresh_token (no rotation); keep the old one in that case.
    const prev = await this.opts.store.get("tokens");
    await this.opts.store.set("tokens", {
      ...tokens,
      refresh_token: tokens.refresh_token ?? prev?.refresh_token,
      obtained_at: Date.now(),
    });
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    if (!this.opts.onRedirect) throw new NeedsLoginError();
    await this.opts.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.opts.store.set("verifier", codeVerifier);
  }
  async codeVerifier(): Promise<string> {
    const v = await this.opts.store.get("verifier");
    if (!v) throw new Error("No PKCE verifier saved. Restart `pnpm login`.");
    return v;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    return this.opts.store.set("discovery", state);
  }
  discoveryState() {
    return this.opts.store.get("discovery");
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const s = this.opts.store;
    switch (scope) {
      case "all":
        return s.delete("client", "tokens", "verifier", "state", "discovery");
      case "verifier":
        return s.delete("verifier", "state");
      default:
        return s.delete(scope);
    }
  }
}
