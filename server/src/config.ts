import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  repoRoot,
  mcpUrl: process.env.DOCSPLUS_MCP_URL ?? "https://prodback.docs.plus/api/mcp",
  docSlug: process.env.DOC_SLUG ?? "ration-club-recipes-test-doc-fictional-data", // TEST doc; real booklet is tt9qajlqe47
  redirectPort: Number(process.env.OAUTH_REDIRECT_PORT ?? 8787),
  secretsDir: path.resolve(repoRoot, process.env.SECRETS_DIR ?? ".secrets"),
  get redirectUrl() {
    return `http://localhost:${this.redirectPort}/callback`;
  },
};
