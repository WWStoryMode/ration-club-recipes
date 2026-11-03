/**
 * Long-running server: ONE instance, with SECRETS_DIR on a persistent disk.
 * Startup: SECRETS_DIR writable → import DOCSPLUS_LOGIN_BUNDLE (only into an empty store) → one-instance lock → serve.
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
import { RecipesService } from "./recipes.js";

async function main() {
  await mkdir(config.secretsDir, { recursive: true, mode: 0o700 });
  await chmod(config.secretsDir, 0o700);
  await access(config.secretsDir, constants.W_OK);

  const store = defaultStore();
  const login = await bootstrapLogin(store, process.env.DOCSPLUS_LOGIN_BUNDLE);
  if (login === "none") console.warn("[start] No docs.plus login yet: the API will answer 503 until one is imported.");

  const lock = new InstanceLock(path.join(config.secretsDir, "server.lock"), {
    onLost: (by) => {
      console.error(`[lock] another server (host ${by?.host}, pid ${by?.pid}) took over this login. Stopping.`);
      process.exit(1);
    },
  });
  await lock.acquire();
  lock.startHeartbeat();

  const port = Number(process.env.PORT ?? 3000);
  const recipes = new RecipesService({ docs: new LazyDocs(config.docSlug, { store }), lock: new InMemoryLock(), slug: config.docSlug });
  const server = serve({ fetch: createApp({ recipes }).fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, () => {
    console.log(`API on http://localhost:${port}  (doc: ${config.docSlug})`);
  });

  const stop = async (signal: string) => {
    console.log(`[start] ${signal}: stopping`);
    server.close();
    await lock.release().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof InstanceLockError ? `[lock] ${err.message}` : err);
  process.exit(1);
});
