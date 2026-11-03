/**
 * Long-running server: ONE instance, with SECRETS_DIR on a persistent disk.
 * Startup: SECRETS_DIR writable → import DOCSPLUS_LOGIN_BUNDLE (only into an empty store) → one-instance lock →
 * protection (Turnstile, rate limits, audit log in DATA_DIR) → serve.
 */
import { access, chmod, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { bootstrapLogin } from "./bootstrap.js";
import { config } from "./config.js";
import { InstanceLock, InstanceLockError } from "./instanceLock.js";
import { LazyDocs } from "./lazyDocs.js";
import { InMemoryLock } from "./lock.js";
import { defaultStore } from "./mcp.js";
import { FileAuditLog, ipHasher, loadSalt } from "./protect/audit.js";
import { parseRate, RateLimiter } from "./protect/rateLimit.js";
import { noHumanCheck, Turnstile, type HumanCheck } from "./protect/turnstile.js";
import { RecipesService } from "./recipes.js";

/** Turnstile is required in production, unless explicitly switched off with TURNSTILE_DISABLED=1. */
function humanCheck(): HumanCheck {
  const t = config.turnstile;
  if (t.secret && !t.disabled) return new Turnstile({ secret: t.secret, siteKey: t.siteKey, hostnames: t.hostnames });
  if (config.production && !t.disabled) {
    throw new Error("TURNSTILE_SECRET is not set. In production every write needs the human check. Set TURNSTILE_SECRET and TURNSTILE_SITE_KEY, or TURNSTILE_DISABLED=1 to run without it.");
  }
  console.warn("[start] Turnstile is OFF: writes are not checked for bots.");
  return noHumanCheck;
}

function limiter(spec: string | undefined, fallback: string) {
  const r = parseRate(spec, fallback);
  return new RateLimiter(r.limit, r.windowMs);
}

async function main() {
  await mkdir(config.secretsDir, { recursive: true, mode: 0o700 });
  await chmod(config.secretsDir, 0o700);
  await access(config.secretsDir, constants.W_OK);

  const store = defaultStore();
  const login = await bootstrapLogin(store, process.env.DOCSPLUS_LOGIN_BUNDLE);
  if (login === "none") console.warn("[start] No docs.plus login yet: the API will answer 503 until one is imported.");

  // Config checks first, so a bad setting never leaves the instance lock behind.
  if (config.production && !config.clientIpHeader) {
    console.warn("[start] CLIENT_IP_HEADER is not set. Behind a proxy every visitor may look like the same IP, so they share one rate limit.");
  }
  const protection = {
    humanCheck: humanCheck(),
    audit: new FileAuditLog(config.dataDir),
    hashIp: ipHasher(await loadSalt(config.dataDir, config.auditSalt)),
    ipHeader: config.clientIpHeader,
    limits: {
      writesPerIp: limiter(config.rates.writesPerIp, "10/600"),
      readsPerIp: limiter(config.rates.readsPerIp, "120/60"),
      writesGlobal: limiter(config.rates.writesGlobal, "30/60"),
    },
  };

  const lock = new InstanceLock(path.join(config.secretsDir, "server.lock"), {
    onLost: (by) => {
      console.error(`[lock] another server (host ${by?.host}, pid ${by?.pid}) took over this login. Stopping.`);
      process.exit(1);
    },
  });
  await lock.acquire();
  lock.startHeartbeat();
  try {
    const port = Number(process.env.PORT ?? 3000);
    const recipes = new RecipesService({ docs: new LazyDocs(config.docSlug, { store }), lock: new InMemoryLock(), slug: config.docSlug });
    const server = serve({ fetch: createApp({ recipes, protection }).fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, () => {
      console.log(`API on http://localhost:${port}  (doc: ${config.docSlug})`);
    });
    server.on("error", (err) => {
      // e.g. EADDRINUSE: never leave the instance lock behind
      console.error(`[start] server error: ${err.message}`);
      void lock.release().finally(() => process.exit(1));
    });

    const stop = async (signal: string) => {
      console.log(`[start] ${signal}: stopping`);
      server.close();
      await lock.release().catch(() => {});
      process.exit(0);
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  } catch (err) {
    await lock.release().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof InstanceLockError ? `[lock] ${err.message}` : err instanceof Error ? `[start] ${err.message}` : err);
  process.exit(1);
});
