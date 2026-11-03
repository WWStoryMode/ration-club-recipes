import { describe, expect, it } from "vitest";
import { createApp, type Protection } from "../src/app.js";
import { InMemoryLock } from "../src/lock.js";
import type { AuditEntry } from "../src/protect/audit.js";
import { RateLimiter } from "../src/protect/rateLimit.js";
import { Turnstile } from "../src/protect/turnstile.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

/** App with real protection, a fake Turnstile that accepts "good-token", and an in-memory audit log. */
function setup(over: Partial<Protection> = {}) {
  const docs = booklet();
  const entries: AuditEntry[] = [];
  const humanCheck = new Turnstile({
    secret: "s",
    siteKey: "site-key",
    fetch: (async (_u: unknown, init?: RequestInit) => Response.json({ success: new URLSearchParams(String(init?.body)).get("response") === "good-token" })) as typeof fetch,
  });
  const protection: Protection = {
    humanCheck,
    audit: { write: async (e) => void entries.push(e) },
    hashIp: (ip) => `hash(${ip})`,
    ipHeader: "x-forwarded-for",
    limits: { writesPerIp: new RateLimiter(3, 600_000), readsPerIp: new RateLimiter(5, 60_000), writesGlobal: new RateLimiter(100, 60_000) },
    ...over,
  };
  const app = createApp({ recipes: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake" }), protection });
  const call = async (method: string, path: string, body?: unknown, ip = "1.1.1.1") => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };
  const pasta = () => docs.byTitle("Pasta Bake");
  const save = (texts: string[], extra: object = {}, ip?: string) =>
    call("PUT", `/api/sections/${pasta().id}`, { baseRev: FakeDocs.rev(pasta()), texts, turnstileToken: "good-token", ...extra }, ip);
  return { docs, entries, call, save, pasta };
}

describe("protected writes", () => {
  it("publishes the site key and honeypot field name", async () => {
    const { call } = setup();
    const r = await call("GET", "/api/config");
    expect(r.json).toMatchObject({ turnstileSiteKey: "site-key", honeypotField: "website" });
  });

  it("saves with a valid token and audits before/after with the IP hash only", async () => {
    const { save, entries, pasta } = setup();
    const r = await save(["**Head Chef: New**"]);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(pasta().blocks).toEqual(["**Head Chef: New**"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "save_section",
      outcome: "saved",
      recipe: "Pasta Bake",
      ipHash: "hash(1.1.1.1)",
      before: [expect.stringContaining("Chef Alpha")],
      after: ["**Head Chef: New**"],
      requestId: r.headers.get("x-request-id"),
    });
    expect(JSON.stringify(entries)).not.toContain("1.1.1.1\"");
  });

  it("requires the human check, and audits the block without writing", async () => {
    const { save, entries, pasta } = setup();
    for (const token of [undefined, "bad-token"]) {
      const r = await save(["x"], { turnstileToken: token });
      expect(r.status).toBe(422);
      expect(r.json.error.message).toMatch(/human/);
      expect(r.json.error.reason).toBeUndefined(); // internal reasons stay in the audit log
    }
    expect(pasta().blocks).not.toEqual(["x"]);
    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["blocked", "turnstile_missing"], ["blocked", "turnstile_failed:"]]);
  });

  it("blocks honeypot submissions before the human check", async () => {
    const { save, entries, pasta } = setup();
    const r = await save(["spam"], { website: "http://spam.example" });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/couldn't be accepted/);
    expect(pasta().blocks).not.toEqual(["spam"]);
    expect(entries[0]).toMatchObject({ outcome: "blocked", reason: "honeypot", sectionId: pasta().id });
    expect(entries[0]!.attempted).toBeUndefined(); // bot text isn't kept
  });

  it("audits refused input and conflicts with what was attempted", async () => {
    const { save, call, entries, pasta } = setup();
    await save(["## heading"]);
    await call("PUT", `/api/sections/${pasta().id}`, { baseRev: "000000000000", texts: ["late edit"], turnstileToken: "good-token" });
    expect(entries.map((e) => e.outcome)).toEqual(["refused", "conflict"]);
    expect(entries[0]!.reason).toMatch(/Headings/);
    expect(entries[1]).toMatchObject({ attempted: ["late edit"], baseRev: "000000000000" });
  });

  it("limits writes per IP with Retry-After, without auditing the flood", async () => {
    const { save, entries } = setup();
    for (let i = 0; i < 3; i++) expect((await save([`edit ${i}`])).status).not.toBe(429);
    const r = await save(["one too many"]);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(500);
    expect(r.json.error.message).toMatch(/wait 10 minutes/);
    expect(entries).toHaveLength(3);
    expect((await save(["other visitor"], {}, "2.2.2.2")).status).toBe(200);
  });

  it("limits all writes together", async () => {
    const { save } = setup({ limits: { writesGlobal: new RateLimiter(1, 60_000) } });
    expect((await save(["a"], {}, "1.1.1.1")).status).toBe(200);
    expect((await save(["b"], {}, "2.2.2.2")).status).toBe(429);
  });

  it("limits reads per IP", async () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) expect((await call("GET", "/api/recipes")).status).toBe(200);
    expect((await call("GET", "/api/recipes")).status).toBe(429);
    expect((await call("GET", "/api/recipes", undefined, "3.3.3.3")).status).toBe(200);
  });

  it("audits added recipes", async () => {
    const { call, entries } = setup();
    const r = await call("POST", "/api/recipes", { title: "Lentil Soup", markdown: "**Head Chef: Z**", turnstileToken: "good-token" });
    expect(r.status).toBe(201);
    expect(entries[0]).toMatchObject({ action: "add_recipe", outcome: "added", recipe: "Lentil Soup", after: ["**Head Chef: Z**"], recipeId: r.json.recipe.id });
  });

  it("sends security headers", async () => {
    const { call } = setup();
    const r = await call("GET", "/api/recipes");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
