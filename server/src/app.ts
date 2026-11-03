import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { ApiError, toApiError } from "./errors.js";
import { noAudit, truncate, type AuditEntry, type AuditLog } from "./protect/audit.js";
import { clientIp } from "./protect/clientIp.js";
import type { RateLimiter } from "./protect/rateLimit.js";
import { noHumanCheck, type HumanCheck } from "./protect/turnstile.js";
import type { RecipesService } from "./recipes.js";
import { LIMITS } from "./validate.js";

/** Name of the hidden form field. People never see or fill it; bots that fill every field do. */
export const HONEYPOT_FIELD = "website";

const protectedFields = {
  turnstileToken: z.string().max(4096).optional(),
  [HONEYPOT_FIELD]: z.string().max(1000).optional(),
};
const SaveSection = z.object({
  baseRev: z.string().regex(/^[0-9a-f]{12}$/, "baseRev must be the 12-character rev you loaded"),
  texts: z.array(z.string().max(LIMITS.sectionChars * 2)).min(1).max(LIMITS.texts),
  ...protectedFields,
});
const AddRecipe = z.object({
  title: z.string().max(LIMITS.titleChars * 2),
  markdown: z.string().max(LIMITS.sectionChars * 2).default(""),
  ...protectedFields,
});
const SECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Protection {
  humanCheck: HumanCheck;
  audit: AuditLog;
  hashIp: (ip: string) => string;
  ipHeader?: string;
  /** Omitted limiters are not applied (tests). index.ts always passes all three. */
  limits?: { readsPerIp?: RateLimiter; writesPerIp?: RateLimiter; writesGlobal?: RateLimiter };
}

const openProtection: Protection = { humanCheck: noHumanCheck, audit: noAudit, hashIp: () => "-" };

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError("invalid", "The request wasn't valid JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

function sectionId(raw: string): string {
  if (!SECTION_ID.test(raw)) throw new ApiError("not_found", "That recipe or section doesn't exist.");
  return raw;
}

function limit(limiter: RateLimiter | undefined, key: string, c: Context) {
  if (!limiter) return;
  const r = limiter.take(key);
  if (!r.ok) {
    c.header("Retry-After", String(r.retryAfter));
    throw new ApiError("rate_limited", `You're making changes very quickly. Please wait ${r.retryAfter > 90 ? `${Math.ceil(r.retryAfter / 60)} minutes` : `${r.retryAfter} seconds`} and try again.`);
  }
}

/** Map a failed write to an audit outcome. */
function outcomeOf(e: ApiError): Pick<AuditEntry, "outcome" | "reason"> {
  const reason = (e.extra.reason as string | undefined) ?? e.message;
  if (e.code === "conflict") return { outcome: "conflict", reason };
  if (e.code === "invalid" || e.code === "not_found") return { outcome: "refused", reason };
  return { outcome: "failed", reason: `${e.code}: ${reason}` };
}

export function createApp(deps: { recipes: RecipesService; protection?: Protection }) {
  const p = deps.protection ?? openProtection;
  const app = new Hono();

  app.use("*", secureHeaders());
  app.use("/api/*", bodyLimit({ maxSize: 128 * 1024, onError: () => { throw new ApiError("invalid", "That's too much text to send at once."); } }));

  app.onError((err, c) => {
    const e = toApiError(err);
    const { reason: _internal, ...extra } = e.extra; // reasons are for the audit log, not visitors
    return c.json({ error: { code: e.code, message: e.message, ...extra } }, e.status as 400);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET") limit(p.limits?.readsPerIp, clientIp(c, p.ipHeader), c);
    await next();
  });

  /**
   * Every write: per-IP and global rate limits → honeypot → human check → the write itself → one audit line,
   * whatever the outcome. Rate-limited requests are not audited (that would let a flood fill the disk).
   */
  async function guardedWrite<T extends { turnstileToken?: string; [HONEYPOT_FIELD]?: string }>(
    c: Context,
    action: AuditEntry["action"],
    schema: z.ZodType<T>,
    run: (b: T, entry: AuditEntry) => Promise<Response>,
    known: Partial<AuditEntry> = {},
  ): Promise<Response> {
    const ip = clientIp(c, p.ipHeader);
    limit(p.limits?.writesPerIp, ip, c);
    limit(p.limits?.writesGlobal, "global", c);

    // What the URL already tells us goes in first, so even blocked attempts record their target.
    const entry: AuditEntry = { ts: new Date().toISOString(), requestId: randomUUID(), action, outcome: "failed", ipHash: p.hashIp(ip), ...known };
    c.header("X-Request-Id", entry.requestId);
    const audit = (e: AuditEntry) => p.audit.write(e).catch((err) => console.error("[audit] could not write the audit log:", err));
    try {
      const b = await body(c, schema);
      if (b[HONEYPOT_FIELD]?.trim()) {
        throw new ApiError("invalid", "Your change couldn't be accepted. Please reload the page and try again.", { reason: "honeypot" });
      }
      await p.humanCheck.verify(b.turnstileToken, ip);
      const res = await run(b, entry);
      await audit(entry);
      return res;
    } catch (err) {
      const e = toApiError(err);
      const o = outcomeOf(e);
      await audit({ ...entry, ...o, outcome: e.extra.reason === "honeypot" || String(e.extra.reason ?? "").startsWith("turnstile") ? "blocked" : o.outcome });
      throw e;
    }
  }

  app.get("/api/config", (c) =>
    c.json({
      turnstileSiteKey: p.humanCheck.siteKey,
      honeypotField: HONEYPOT_FIELD,
      limits: { sectionChars: LIMITS.sectionChars, titleChars: LIMITS.titleChars, links: LIMITS.links },
    }),
  );

  app.get("/api/recipes", async (c) => c.json({ recipes: await deps.recipes.listRecipes() }));

  app.get("/api/recipes/:id", async (c) => c.json({ recipe: await deps.recipes.getRecipe(sectionId(c.req.param("id"))) }));

  app.put("/api/sections/:id", (c) =>
    guardedWrite(c, "save_section", SaveSection, async (b, entry) => {
      const id = sectionId(c.req.param("id"));
      Object.assign(entry, { baseRev: b.baseRev, attempted: truncate(b.texts) });
      const r = await deps.recipes.saveSection(id, b.baseRev, b.texts);
      const texts = (v: typeof r.section) => v.parts.flatMap((x) => (x.type === "text" ? [x.markdown] : []));
      Object.assign(entry, {
        outcome: r.changed ? "saved" : "unchanged",
        recipeId: r.recipe.id,
        recipe: r.recipe.title,
        newRev: r.section.rev,
        before: texts(r.before),
        after: texts(r.section),
        attempted: undefined,
      });
      return c.json({ section: r.section });
    }, { sectionId: c.req.param("id").slice(0, 64) }),
  );

  app.post("/api/recipes", (c) =>
    guardedWrite(c, "add_recipe", AddRecipe, async (b, entry) => {
      Object.assign(entry, { recipe: b.title.slice(0, 200), attempted: truncate([b.markdown]) });
      const r = await deps.recipes.addRecipe(b.title, b.markdown);
      Object.assign(entry, { outcome: "added", recipeId: r.id, sectionId: r.id, recipe: r.title, after: [b.markdown], attempted: undefined });
      return c.json({ recipe: r }, 201);
    }),
  );

  return app;
}
