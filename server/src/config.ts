import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  repoRoot,
  mcpUrl: process.env.DOCSPLUS_MCP_URL ?? "https://prodback.docs.plus/api/mcp",
  docSlug: process.env.DOC_SLUG ?? "ration-club-recipes-test-doc-fictional-data", // TEST doc; real booklet is tt9qajlqe47
  redirectPort: Number(process.env.OAUTH_REDIRECT_PORT ?? 8787),
  secretsDir: path.resolve(repoRoot, process.env.SECRETS_DIR ?? ".secrets"),
  /** Audit log and its salt. Must be on the persistent disk in production. */
  dataDir: path.resolve(repoRoot, process.env.DATA_DIR ?? ".data"),
  production: process.env.NODE_ENV === "production",
  /** Header your host sets with the visitor's IP (e.g. "fly-client-ip", "x-forwarded-for"). Unset = TCP peer. */
  clientIpHeader: process.env.CLIENT_IP_HEADER?.trim() || undefined,
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY?.trim() || null,
    secret: process.env.TURNSTILE_SECRET?.trim() || undefined,
    disabled: process.env.TURNSTILE_DISABLED === "1",
    hostnames: (process.env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  },
  auditSalt: process.env.AUDIT_SALT,
  rates: {
    writesPerIp: process.env.RATE_WRITES_PER_IP, // default 10/600
    readsPerIp: process.env.RATE_READS_PER_IP, // default 120/60
    writesGlobal: process.env.RATE_WRITES_GLOBAL, // default 30/60
  },
  /** Phase 4b. REQUIRE_APPROVAL=1: visitors' changes wait for an organiser (needs ADMIN_TOKEN). */
  requireApproval: process.env.REQUIRE_APPROVAL === "1",
  adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
  queue: { max: process.env.QUEUE_MAX, perIp: process.env.QUEUE_PER_IP },
  /** CHAT_SUMMARIES=1: post a one-line note in the docs.plus chat after each change is written. */
  chatSummaries: process.env.CHAT_SUMMARIES === "1",
  get redirectUrl() {
    return `http://localhost:${this.redirectPort}/callback`;
  },
};
