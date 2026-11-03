/** Long-running server (local dev, Railway/Render/Fly). Serverless entry points come with the Redis phase. */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { LazyDocs } from "./lazyDocs.js";
import { InMemoryLock } from "./lock.js";
import { RecipesService } from "./recipes.js";

const port = Number(process.env.PORT ?? 3000);
const recipes = new RecipesService({ docs: new LazyDocs(config.docSlug), lock: new InMemoryLock(), slug: config.docSlug });

serve({ fetch: createApp({ recipes }).fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, () => {
  console.log(`API on http://localhost:${port}  (doc: ${config.docSlug})`);
});
