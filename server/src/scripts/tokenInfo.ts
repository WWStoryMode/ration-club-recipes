/**
 * pnpm token-info [--refresh]: what kind of tokens docs.plus issues. Never prints a token, only facts and short hashes.
 * --refresh forces one refresh-token grant, saves the result straight away, and reports whether the refresh token rotated.
 * --expire-now (testing) marks the access token as expired, so a running server refreshes on its next call.
 * It never reuses an old refresh token, because Supabase revokes the whole token family when a rotated token is reused.
 */
import { createHash } from "node:crypto";
import { sharedFetch, TokenRefresher } from "../auth/refresh.js";
import { config } from "../config.js";
import { connect, defaultStore, makeProvider } from "../mcp.js";

const store = defaultStore();
const h = (s?: string) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 10) : "-");

function jwtTimes(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { exp?: number; iat?: number };
    return payload;
  } catch {
    return undefined;
  }
}

async function describe(label: string) {
  const t = await store.get("tokens");
  if (!t) throw new Error("No tokens saved. Run `pnpm login` first.");
  const jwt = jwtTimes(t.access_token);
  const expiresAt = t.expires_in ? new Date(t.obtained_at + t.expires_in * 1000) : undefined;
  console.log(`${label}`);
  console.log(`  token_type:            ${t.token_type}`);
  console.log(`  scope:                 ${t.scope ?? "-"}`);
  console.log(`  refresh token:         ${t.refresh_token ? `yes (sha256 ${h(t.refresh_token)}, ${t.refresh_token.length} chars)` : "NO"}`);
  console.log(`  expires_in:            ${t.expires_in ?? "-"} s${t.expires_in ? ` (${(t.expires_in / 60).toFixed(0)} min)` : ""}`);
  console.log(`  obtained_at:           ${new Date(t.obtained_at).toISOString()}`);
  console.log(`  expires_at:            ${expiresAt?.toISOString() ?? "-"}`);
  if (jwt?.exp) console.log(`  access JWT exp-iat:    ${jwt.iat ? `${jwt.exp - jwt.iat} s` : "-"} (exp ${new Date(jwt.exp * 1000).toISOString()})`);
  return t;
}

async function main() {
  const before = await describe("CURRENT TOKENS");

  if (process.argv.includes("--expire-now")) {
    // Dev/testing only: pretend the access token is about to expire, so the server's TokenRefresher refreshes on its next call.
    await store.set("tokens", { ...before, obtained_at: Date.now() - (before.expires_in ?? 3600) * 1000 });
    console.log("\nMarked the access token as expired. The next API call will refresh it.");
    return;
  }
  if (!process.argv.includes("--refresh")) {
    console.log("\nRun with --refresh to test refresh and rotation, or --expire-now to make the server refresh.");
    return;
  }

  const provider = makeProvider(store);
  const { before: oldRt, after: newRt } = await new TokenRefresher({ store, provider, serverUrl: config.mcpUrl, fetch: sharedFetch }).refresh();
  const after = await store.get("tokens");

  console.log("\nREFRESH");
  console.log(`  new access token:      ${after?.access_token !== before.access_token ? "yes" : "no"}`);
  console.log(`  ROTATION:              ${newRt && newRt !== oldRt ? `YES (${h(oldRt)} → ${h(newRt)})` : "no"}`);
  await describe("\nTOKENS AFTER REFRESH");

  const { client: mcp } = await connect(provider);
  const { tools } = await mcp.listTools();
  console.log(`\nRefreshed token works: listTools returned ${tools.length} tools.`);
  await mcp.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`token-info failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
