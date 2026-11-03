/**
 * pnpm export-login: print the login in SECRETS_DIR as one base64 bundle for DOCSPLUS_LOGIN_BUNDLE on the host.
 * The bundle goes to stdout (so `| pbcopy` captures only it); warnings go to stderr.
 * Use a SEPARATE login for the server:  SECRETS_DIR=.secrets-server pnpm run login
 */
import { config } from "../config.js";
import { encodeBundle, exportBundle } from "../bootstrap.js";
import { defaultStore } from "../mcp.js";

async function main() {
  const bundle = encodeBundle(await exportBundle(defaultStore()));
  console.error(`Login bundle from ${config.secretsDir}.`);
  console.error("SECRET: it can act as you on docs.plus. Paste it only into your host's env as DOCSPLUS_LOGIN_BUNDLE,");
  console.error("deploy once, then delete the variable and this SECRETS_DIR. Never commit it or paste it in chat.\n");
  process.stdout.write(bundle + "\n");
}

main().catch((err) => {
  console.error(`export-login failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
