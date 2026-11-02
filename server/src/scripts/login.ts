/**
 * pnpm login: one-time OAuth sign-in to docs.plus as the doc owner.
 * Safe to rerun. If tokens still work (or can be refreshed), it does nothing. Otherwise it opens the browser.
 * --force throws away the saved tokens first (the client registration is kept).
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import open from "open";
import { NeedsLoginError } from "../auth/DocsPlusOAuthProvider.js";
import { waitForCallback } from "../auth/callbackServer.js";
import { config } from "../config.js";
import { connect, defaultStore, makeProvider, makeTransport } from "../mcp.js";

const store = defaultStore();

async function trySilent(): Promise<boolean> {
  try {
    const { client } = await connect(makeProvider(store));
    const { tools } = await client.listTools();
    console.log(`Already logged in (${tools.length} tools available). Use --force to sign in again.`);
    await client.close();
    return true;
  } catch (err) {
    if (err instanceof NeedsLoginError || err instanceof UnauthorizedError) return false;
    throw err;
  }
}

async function main() {
  if (process.argv.includes("--force")) {
    await store.delete("tokens", "verifier", "state");
    console.log("Cleared saved tokens.");
  } else if (await store.get("tokens")) {
    if (await trySilent()) return;
    console.log("Saved tokens no longer work; signing in again.");
  }

  const callback = waitForCallback(config.redirectPort);
  await callback.listening;

  const provider = makeProvider(store, async (url) => {
    console.log("\nOpening docs.plus in your browser. Sign in (magic link) if asked.");
    console.log(`Check that the consent page names ${config.redirectUrl}, then click Allow.\n`);
    console.log(`If the browser does not open, visit:\n${url}\n`);
    await open(url.toString()).catch(() => {});
  });
  const transport = makeTransport(provider);
  const client = new Client({ name: "ration-club-recipes", version: "0.1.0" });

  try {
    await client.connect(transport);
    console.log("Already authorized.");
    callback.close();
    await client.close();
    return;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      callback.close();
      throw err;
    }
  }

  console.log("Waiting for the browser (5 minutes)…");
  const { code, state } = await callback.result;
  const expected = await store.get("state");
  if (!expected || state !== expected) {
    await store.delete("verifier", "state");
    throw new Error("OAuth state mismatch: the callback did not come from this login attempt. Run `pnpm login` again.");
  }
  await transport.finishAuth(code);
  await store.delete("verifier", "state");

  const fresh = await connect(makeProvider(store));
  const { tools } = await fresh.client.listTools();
  const tokens = await store.get("tokens");
  console.log(`\nLogged in. ${tools.length} tools available. Refresh token received: ${tokens?.refresh_token ? "yes" : "NO"}.`);
  console.log(`Credentials saved in ${config.secretsDir} (gitignored). Revoke at docs.plus Settings › Connected apps.`);
  await fresh.client.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nLogin failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
