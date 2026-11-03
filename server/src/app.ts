import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { chatText, noChat, type ChatNotifier } from "./chat.js";
import { ApiError, toApiError } from "./errors.js";
import { InMemoryLock } from "./lock.js";
import { noAudit, truncate, type AuditEntry, type AuditLog } from "./protect/audit.js";
import { clientIp } from "./protect/clientIp.js";
import { RateLimiter } from "./protect/rateLimit.js";
import { noHumanCheck, type HumanCheck } from "./protect/turnstile.js";
import { isPendingId, type PendingChange, type PendingQueue } from "./queue.js";
import type { RecipesService, SectionView } from "./recipes.js";
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
}

export function createApp(deps: AppDeps) {
  const p = deps.protection ?? openProtection;
  const chat = deps.chat ?? noChat;
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
      requiresApproval: !!deps.queue,
      limits: { sectionChars: LIMITS.sectionChars, titleChars: LIMITS.titleChars, links: LIMITS.links },
    }),
  );

  app.get("/api/recipes", async (c) => c.json({ recipes: await deps.recipes.listRecipes() }));

  app.get("/api/recipes/:id", async (c) => c.json({ recipe: await deps.recipes.getRecipe(sectionId(c.req.param("id"))) }));

  app.put("/api/sections/:id", (c) =>
    guardedWrite(c, "save_section", SaveSection, async (b, entry) => {
      const id = sectionId(c.req.param("id"));
      Object.assign(entry, { baseRev: b.baseRev, attempted: truncate(b.texts) });

      if (deps.queue) {
        const chk = await deps.recipes.checkSection(id, b.baseRev, b.texts);
        Object.assign(entry, { recipeId: chk.recipe.id, recipe: chk.recipe.title, before: texts(chk.before) });
        if (!chk.changed) {
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
          baseRev: b.baseRev,
          before: texts(chk.before),
          texts: chk.texts,
        });
        Object.assign(entry, { outcome: "queued", pendingId: item.id, attempted: chk.texts });
        return c.json({ pending: { id: item.id }, message: QUEUED_MESSAGE }, 202);
      }

      const r = await deps.recipes.saveSection(id, b.baseRev, b.texts);
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
    }, { sectionId: c.req.param("id").slice(0, 64) }),
  );

  app.post("/api/recipes", (c) =>
    guardedWrite(c, "add_recipe", AddRecipe, async (b, entry) => {
      Object.assign(entry, { recipe: b.title.slice(0, 200), attempted: truncate([b.markdown]) });

      if (deps.queue) {
        const chk = await deps.recipes.checkNewRecipe(b.title, b.markdown);
        const item = await deps.queue.add({ kind: "add_recipe", requestId: entry.requestId, ipHash: entry.ipHash, title: chk.title, markdown: chk.markdown });
        Object.assign(entry, { outcome: "queued", recipe: chk.title, pendingId: item.id, attempted: [chk.markdown] });
        return c.json({ pending: { id: item.id }, message: QUEUED_MESSAGE }, 202);
      }

      const r = await deps.recipes.addRecipe(b.title, b.markdown);
      Object.assign(entry, { outcome: "added", recipeId: r.id, sectionId: r.id, recipe: r.title, after: [b.markdown], attempted: undefined });
      chat.notify(undefined, chatText.added(r.title, false));
      return c.json({ recipe: r }, 201);
    }),
  );

  if (deps.queue && deps.adminToken) mountAdmin(app, deps as Required<Pick<AppDeps, "queue" | "adminToken">> & AppDeps, p, chat);

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
          Object.assign(entry, { sectionId: it.sectionId, recipeId: it.recipeId, recipe: it.recipe, baseRev: it.baseRev, attempted: truncate(it.texts) });
          const r = await deps.recipes.saveSection(it.sectionId, overwrite ? null : it.baseRev, it.texts);
          Object.assign(entry, { outcome: r.changed ? "saved" : "unchanged", newRev: r.section.rev, before: texts(r.before), after: texts(r.section), attempted: undefined });
          if (r.changed) chat.notify(r.recipe.id, chatText.updated(r.recipe.title, r.section.title, true));
          res = c.json({ approved: it.id, section: r.section });
        } else {
          Object.assign(entry, { recipe: it.title, attempted: truncate([it.markdown]) });
          const r = await deps.recipes.addRecipe(it.title, it.markdown);
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
