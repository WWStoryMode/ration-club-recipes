import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { chatText, noChat, type ChatNotifier } from "./chat.js";
import { ApiError, toApiError } from "./errors.js";
import type { Health } from "./health.js";
import { InMemoryLock } from "./lock.js";
import { noAudit, truncate, type AuditEntry, type AuditLog } from "./protect/audit.js";
import { clientIp } from "./protect/clientIp.js";
import { RateLimiter } from "./protect/rateLimit.js";
import { noHumanCheck, type HumanCheck } from "./protect/turnstile.js";
import { PHOTO_LIMITS } from "./photos.js";
import { FORM_LIMITS } from "./recipeForm.js";
import { isPendingId, type PendingChange, type PendingQueue } from "./queue.js";
import type { NewPhoto, PhotoAppend, RecipesService, SectionView } from "./recipes.js";
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
const line = z.string().max(FORM_LIMITS.line * 2);
const lines = z.array(line).max(FORM_LIMITS.lines * 2).default([]);
const field = (max: number) => z.string().max(max * 2).default("");
/** A visitor's recipe form. No `other`: text that fits no field always comes from the document. */
const Form = z.object({
  headChef: field(FORM_LIMITS.name),
  helpers: field(FORM_LIMITS.name),
  date: z.string().max(10).default(""),
  serves: field(FORM_LIMITS.short),
  cost: field(FORM_LIMITS.short),
  ingredients: lines,
  method: lines,
  tips: lines,
  story: field(FORM_LIMITS.story),
  /** A caption for each photo already in the recipe, in order. */
  photos: z.array(z.object({ caption: field(FORM_LIMITS.caption) })).max(PHOTO_LIMITS.perRecipe * 2).default([]),
  /** Links for new photos, each with a caption. */
  newPhotos: z.array(z.object({ url: z.string().max(PHOTO_LIMITS.url * 2), caption: field(FORM_LIMITS.caption) })).max(PHOTO_LIMITS.perSave * 2).default([]),
});
const SaveForm = z.object({
  baseRev: z.string().regex(/^[0-9a-f]{12}$/, "baseRev must be the 12-character rev you loaded"),
  form: Form,
  ...protectedFields,
});
const AddRecipe = z.object({
  title: z.string().max(LIMITS.titleChars * 2),
  /** Either form values (the web page) or Markdown (API clients). */
  form: Form.optional(),
  markdown: z.string().max(LIMITS.sectionChars * 2).default(""),
  ...protectedFields,
});
const SECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const Approve = z.object({ overwrite: z.boolean().default(false) });
const Reject = z.object({ note: z.string().max(500).optional() });

/** Shown to visitors when their change is queued. */
export const QUEUED_MESSAGE = "Thanks! Your change has been sent to the organisers. It will appear in the booklet once they've checked it.";

const texts = (v: SectionView) => v.parts.flatMap((x) => (x.type === "text" ? [x.markdown] : []));

/** Organiser access to the approval queue. The token is compared in constant time; failures are rate-limited per IP. */
function tokenMatches(expected: string, got: string | undefined): boolean {
  if (!got) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(expected), h(got));
}

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

export interface AppDeps {
  recipes: RecipesService;
  protection?: Protection;
  /** Set = REQUIRE_APPROVAL: visitors' changes are queued, and only an organiser's approval writes them. */
  queue?: PendingQueue;
  /** Bearer token for /api/admin/*. Unset = no admin routes. */
  adminToken?: string;
  /** Optional one-line notes in the docs.plus chat after a change is written. */
  chat?: ChatNotifier;
  /** The built web page (web/dist). Served for every non-API GET. Unset = API only (local dev uses Vite). */
  webRoot?: string;
  /** docs.plus health, for GET /health/docs. */
  health?: Health;
}

/**
 * Only our own files, plus Cloudflare Turnstile's script and frame. Styles allow 'unsafe-inline' because the
 * Turnstile script styles its own frame. Images may come from any https site: recipe photos are links to pictures
 * hosted elsewhere. No other origin can run code, be framed, or receive form posts.
 */
const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
  frameSrc: ["https://challenges.cloudflare.com"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "https:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

export function createApp(deps: AppDeps) {
  const p = deps.protection ?? openProtection;
  const chat = deps.chat ?? noChat;
  const app = new Hono();

  app.use("*", secureHeaders({ contentSecurityPolicy: CSP }));
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

  /**
   * Liveness: the process is up and answering. Never calls docs.plus, so a dead login can't make the host restart
   * the server in a loop. For the host's health check.
   */
  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok" });
  });

  /**
   * Can the server still act on docs.plus? 503 when it can't (for example the login needs renewing), so an uptime
   * monitor can alert you. Calls docs.plus at most once a minute, however often it is polled.
   */
  app.get("/health/docs", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.health) return c.json({ status: "unknown" }, 503);
    const h = await deps.health.check();
    return c.json({ status: h.ok ? "ok" : "degraded", docsPlus: h.docsPlus, ...(h.lastSuccess ? { lastSuccess: h.lastSuccess } : {}) }, h.ok ? 200 : 503);
  });

  app.get("/api/config", (c) =>
    c.json({
      turnstileSiteKey: p.humanCheck.siteKey,
      honeypotField: HONEYPOT_FIELD,
      requiresApproval: !!deps.queue,
      limits: { sectionChars: LIMITS.sectionChars, titleChars: LIMITS.titleChars, links: LIMITS.links, form: FORM_LIMITS, photos: { perSave: PHOTO_LIMITS.perSave, perRecipe: PHOTO_LIMITS.perRecipe } },
    }),
  );

  app.get("/api/recipes", async (c) => c.json({ recipes: await deps.recipes.listRecipes() }));

  app.get("/api/recipes/:id", async (c) => c.json({ recipe: await deps.recipes.getRecipe(sectionId(c.req.param("id"))) }));

  /** Save (or, with the approval queue, queue) new text parts for a section. Shared by the section and form routes. */
  async function saveTexts(c: Context, entry: AuditEntry, id: string, baseRev: string, parts: string[], append?: PhotoAppend): Promise<Response> {
    Object.assign(entry, { sectionId: id, baseRev, attempted: truncate(parts), photos: append?.photos.map((p) => p.url) });

    if (deps.queue) {
      const chk = await deps.recipes.checkSection(id, baseRev, parts);
      Object.assign(entry, { recipeId: chk.recipe.id, recipe: chk.recipe.title, before: texts(chk.before) });
      if (!chk.changed && !append) {
        Object.assign(entry, { outcome: "unchanged", attempted: undefined });
        return c.json({ section: chk.before });
      }
      const item = await deps.queue.add({
        kind: "save_section",
        requestId: entry.requestId,
        ipHash: entry.ipHash,
        sectionId: id,
        section: chk.before.title,
        recipeId: chk.recipe.id,
        recipe: chk.recipe.title,
        baseRev,
        before: texts(chk.before),
        texts: chk.texts,
        ...(append ? { photos: append.photos } : {}),
      });
      Object.assign(entry, { outcome: "queued", pendingId: item.id, attempted: chk.texts });
      return c.json({ pending: { id: item.id }, message: QUEUED_MESSAGE }, 202);
    }

    const r = await deps.recipes.saveSection(id, baseRev, parts, append);
    Object.assign(entry, {
      outcome: r.changed ? "saved" : "unchanged",
      recipeId: r.recipe.id,
      recipe: r.recipe.title,
      newRev: r.section.rev,
      before: texts(r.before),
      after: texts(r.section),
      attempted: undefined,
    });
    if (r.changed) chat.notify(r.recipe.id, chatText.updated(r.recipe.title, r.section.title, false));
    return c.json({ section: r.section });
  }

  app.put("/api/sections/:id", (c) =>
    guardedWrite(c, "save_section", SaveSection, (b, entry) => saveTexts(c, entry, sectionId(c.req.param("id")), b.baseRev, b.texts), {
      sectionId: c.req.param("id").slice(0, 64),
    }),
  );

  /** The web page's edit form: form values in, the booklet's layout out. */
  app.put("/api/recipes/:id", (c) =>
    guardedWrite(c, "save_section", SaveForm, async (b, entry) => {
      const id = sectionId(c.req.param("id"));
      const { parts, append } = await deps.recipes.formSave(id, b.baseRev, b.form);
      return saveTexts(c, entry, id, b.baseRev, parts, append);
    }, { sectionId: c.req.param("id").slice(0, 64) }),
  );

  app.post("/api/recipes", (c) =>
    guardedWrite(c, "add_recipe", AddRecipe, async (b, entry) => {
      const markdown = b.form ? deps.recipes.formBody(b.form) : b.markdown;
      Object.assign(entry, { recipe: b.title.slice(0, 200), attempted: truncate([markdown]) });
      const chk = await deps.recipes.checkNewRecipe(b.title, markdown); // name and text first, before fetching photo links
      const append = await deps.recipes.photoAppend(b.form?.newPhotos ?? [], 0);
      if (append) entry.photos = append.photos.map((p) => p.url);

      if (deps.queue) {
        const item = await deps.queue.add({
          kind: "add_recipe",
          requestId: entry.requestId,
          ipHash: entry.ipHash,
          title: chk.title,
          markdown: chk.markdown,
          ...(append ? { photos: append.photos } : {}),
        });
        Object.assign(entry, { outcome: "queued", recipe: chk.title, pendingId: item.id, attempted: [chk.markdown] });
        return c.json({ pending: { id: item.id }, message: QUEUED_MESSAGE }, 202);
      }

      const r = await deps.recipes.addRecipe(b.title, markdown, append);
      Object.assign(entry, { outcome: "added", recipeId: r.id, sectionId: r.id, recipe: r.title, after: [markdown], attempted: undefined });
      chat.notify(undefined, chatText.added(r.title, false));
      return c.json({ recipe: r }, 201);
    }),
  );

  if (deps.queue && deps.adminToken) mountAdmin(app, deps as Required<Pick<AppDeps, "queue" | "adminToken">> & AppDeps, p, chat);

  if (deps.webRoot) {
    const root = deps.webRoot;
    // Hashed build files never change: cache them for a year. index.html is re-checked every time.
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    const files = serveStatic({ root });
    const page = serveStatic({ root, path: "index.html" });
    app.get("*", async (c, next) => (c.req.path.startsWith("/api/") || c.req.path.startsWith("/health") ? next() : files(c, next)));
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/assets/") || c.req.path.startsWith("/health")) return next();
      c.header("Cache-Control", "no-cache");
      return page(c, next);
    });
  }

    return app;
}

/**
 * Organiser routes for the approval queue. All need `Authorization: Bearer <ADMIN_TOKEN>`.
 * Every decision is audited (action approve/reject, with the pending id). Decisions on one item never overlap.
 */
function mountAdmin(app: Hono, deps: AppDeps & { queue: PendingQueue; adminToken: string }, p: Protection, chat: ChatNotifier) {
  const fails = new RateLimiter(10, 10 * 60_000);
  const decide = new InMemoryLock();
  const audit = (e: AuditEntry) => p.audit.write(e).catch((err) => console.error("[audit] could not write the audit log:", err));

  app.use("/api/admin/*", async (c, next) => {
    const ip = clientIp(c, p.ipHeader);
    const blocked = fails.peek(ip);
    if (!blocked.ok) {
      c.header("Retry-After", String(blocked.retryAfter));
      throw new ApiError("rate_limited", "Too many wrong admin tokens. Please wait and try again.");
    }
    const got = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
    if (!tokenMatches(deps.adminToken, got)) {
      fails.take(ip);
      return c.json({ error: { code: "unauthorized", message: "Admin token missing or wrong." } }, 401);
    }
    await next();
  });

  const item = async (raw: string): Promise<PendingChange> => {
    const found = isPendingId(raw) ? await deps.queue.get(raw) : undefined;
    if (!found) throw new ApiError("not_found", "That pending change doesn't exist. It may already have been approved or rejected.");
    return found;
  };

  app.get("/api/admin/pending", async (c) => c.json({ pending: await deps.queue.list() }));

  /** One item, plus (for a section change) the section as it is now and whether it changed since the visitor loaded it. */
  app.get("/api/admin/pending/:id", async (c) => {
    const it = await item(c.req.param("id"));
    if (it.kind !== "save_section") return c.json({ pending: it });
    const current = await deps.recipes.currentSection(it.sectionId);
    return c.json({ pending: it, current: texts(current), changedSince: current.rev !== it.baseRev });
  });

  const decision = (action: "approve" | "reject", c: Context, id: string): AuditEntry => {
    const requestId = randomUUID();
    c.header("X-Request-Id", requestId);
    return { ts: new Date().toISOString(), requestId, action, outcome: "failed", ipHash: p.hashIp(clientIp(c, p.ipHeader)), pendingId: id };
  };

  app.post("/api/admin/pending/:id/approve", (c) =>
    decide.withLock("decide", async () => {
      const entry = decision("approve", c, c.req.param("id").slice(0, 64));
      try {
        const { overwrite } = await body(c, Approve);
        const it = await item(c.req.param("id"));
        let res: Response;
        if (it.kind === "save_section") {
          Object.assign(entry, { sectionId: it.sectionId, recipeId: it.recipeId, recipe: it.recipe, baseRev: it.baseRev, attempted: truncate(it.texts), photos: it.photos?.map((x) => x.url) });
          const append = await approvedPhotos(deps.recipes, it.photos, it.recipeId);
          const r = await deps.recipes.saveSection(it.sectionId, overwrite ? null : it.baseRev, it.texts, append);
          Object.assign(entry, { outcome: r.changed ? "saved" : "unchanged", newRev: r.section.rev, before: texts(r.before), after: texts(r.section), attempted: undefined });
          if (r.changed) chat.notify(r.recipe.id, chatText.updated(r.recipe.title, r.section.title, true));
          res = c.json({ approved: it.id, section: r.section });
        } else {
          Object.assign(entry, { recipe: it.title, attempted: truncate([it.markdown]), photos: it.photos?.map((x) => x.url) });
          const r = await deps.recipes.addRecipe(it.title, it.markdown, await approvedPhotos(deps.recipes, it.photos));
          Object.assign(entry, { outcome: "added", recipeId: r.id, sectionId: r.id, recipe: r.title, after: [it.markdown], attempted: undefined });
          chat.notify(undefined, chatText.added(r.title, true));
          res = c.json({ approved: it.id, recipe: r });
        }
        await deps.queue.remove(it.id);
        await audit(entry);
        return res;
      } catch (err) {
        const e = toApiError(err);
        await audit({ ...entry, ...outcomeOf(e) });
        if (e.code === "conflict" && e.extra.latest) {
          // Keep the item: the organiser can reject it, or approve again with overwrite.
          throw new ApiError("conflict", "This section changed after the visitor started editing. Reject this change, or approve it with overwrite to replace the newer text.", { latest: e.extra.latest });
        }
        throw e;
      }
    }),
  );

  app.post("/api/admin/pending/:id/reject", (c) =>
    decide.withLock("decide", async () => {
      const entry = decision("reject", c, c.req.param("id").slice(0, 64));
      const { note } = await body(c, Reject);
      const it = await item(c.req.param("id"));
      Object.assign(entry, it.kind === "save_section"
        ? { sectionId: it.sectionId, recipeId: it.recipeId, recipe: it.recipe, attempted: truncate(it.texts) }
        : { recipe: it.title, attempted: truncate([it.markdown]) });
      await deps.queue.remove(it.id);
      await audit({ ...entry, outcome: "rejected", note: note?.trim() || undefined });
      return c.json({ rejected: it.id });
    }),
  );
}

/**
 * Photo links in a queued change are checked again when approved: the picture behind a link can change while it waits.
 * The per-recipe limit counts the photos the recipe has now.
 */
async function approvedPhotos(recipes: RecipesService, photos: NewPhoto[] | undefined, recipeId?: string): Promise<PhotoAppend | undefined> {
  if (!photos?.length) return undefined;
  const existing = recipeId ? (await recipes.getRecipe(recipeId)).form.values.photos.length : 0;
  return recipes.photoAppend(photos, existing);
}
