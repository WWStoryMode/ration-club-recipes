import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, QUEUED_MESSAGE, type Protection } from "../src/app.js";
import type { ChatNotifier } from "../src/chat.js";
import { InMemoryLock } from "../src/lock.js";
import type { AuditEntry } from "../src/protect/audit.js";
import { noHumanCheck } from "../src/protect/turnstile.js";
import { FilePendingQueue } from "../src/queue.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

const TOKEN = "a".repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(opts: { perIp?: number; max?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-"));
  dirs.push(dir);
  const docs = booklet();
  const entries: AuditEntry[] = [];
  const notes: Array<[string | undefined, string]> = [];
  const chat: ChatNotifier = { notify: (id, text) => void notes.push([id, text]) };
  const protection: Protection = { humanCheck: noHumanCheck, audit: { write: async (e) => void entries.push(e) }, hashIp: (ip) => `hash(${ip})`, ipHeader: "x-forwarded-for" };
  const queue = new FilePendingQueue(path.join(dir, "pending"), opts);
  const app = createApp({ recipes: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake", cacheMs: 0 }), protection, queue, adminToken: TOKEN, chat });
  const call = async (method: string, url: string, body?: unknown, o: { ip?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": o.ip ?? "1.1.1.1" };
    if (o.token !== null && url.startsWith("/api/admin")) headers.authorization = `Bearer ${o.token ?? TOKEN}`;
    const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const pasta = () => docs.byTitle("Pasta Bake");
  const propose = (texts: string[], ip?: string) => call("PUT", `/api/sections/${pasta().id}`, { baseRev: FakeDocs.rev(pasta()), texts }, { ip });
  return { dir, docs, entries, notes, queue, call, pasta, propose };
}

describe("approval queue (REQUIRE_APPROVAL)", () => {
  it("queues a visitor's edit without touching the document, and says so", async () => {
    const { docs, propose, queue, entries, pasta, call, dir } = await setup();
    const before = [...pasta().blocks];
    const r = await propose(["**Head Chef: Queued**"]);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ message: QUEUED_MESSAGE, pending: { id: expect.any(String) } });
    expect(pasta().blocks).toEqual(before);
    expect(docs.calls.some((c) => c.startsWith("edit"))).toBe(false);

    const [item] = await queue.list();
    expect(item).toMatchObject({ kind: "save_section", recipe: "Pasta Bake", section: "Pasta Bake", texts: ["**Head Chef: Queued**"], ipHash: "hash(1.1.1.1)" });
    expect(entries.at(-1)).toMatchObject({ action: "save_section", outcome: "queued", pendingId: item!.id, attempted: ["**Head Chef: Queued**"] });
    expect((await call("GET", "/api/config")).json.requiresApproval).toBe(true);

    const files = await readdir(path.join(dir, "pending"));
    expect(files).toEqual([`${item!.id}.json`]);
    expect((await stat(path.join(dir, "pending", files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("checks before queueing: bad text, stale rev and no-op edits never reach the queue", async () => {
    const { propose, call, queue, pasta } = await setup();
    expect((await propose(["# Heading"])).status).toBe(422);
    expect((await call("PUT", `/api/sections/${pasta().id}`, { baseRev: "000000000000", texts: ["x"] })).status).toBe(409);
    const same = pasta().blocks.filter((b) => b.trim()).join("\n\n");
    const r = await propose([same]);
    expect(r.status).toBe(200);
    expect(await queue.list()).toEqual([]);
  });

  it("approve writes the change, removes the item, audits it and posts a chat note", async () => {
    const { propose, call, queue, pasta, entries, notes } = await setup();
    const { json } = await propose(["**Head Chef: Approved**"]);
    const r = await call("POST", `/api/admin/pending/${json.pending.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(pasta().blocks).toEqual(["**Head Chef: Approved**"]);
    expect(await queue.list()).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ action: "approve", outcome: "saved", pendingId: json.pending.id, recipe: "Pasta Bake", after: ["**Head Chef: Approved**"] });
    expect(notes).toEqual([[pasta().id, 'Recipe updated through Ration Club Recipes: "Pasta Bake". Approved by an organiser.']]);
  });

  it("a change overtaken by another approval conflicts and stays queued; --overwrite then applies it", async () => {
    const { propose, call, queue, pasta } = await setup();
    const a = (await propose(["first"], "1.1.1.1")).json.pending.id;
    const b = (await propose(["second"], "2.2.2.2")).json.pending.id;
    expect((await call("POST", `/api/admin/pending/${a}/approve`, {})).status).toBe(200);

    const show = await call("GET", `/api/admin/pending/${b}`);
    expect(show.json).toMatchObject({ changedSince: true, current: ["first"] });

    const r = await call("POST", `/api/admin/pending/${b}/approve`, {});
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/overwrite/);
    expect((await queue.list()).map((x) => x.id)).toEqual([b]);

    expect((await call("POST", `/api/admin/pending/${b}/approve`, { overwrite: true })).status).toBe(200);
    expect(pasta().blocks).toEqual(["second"]);
  });

  it("reject removes the item without writing and keeps the note in the audit log", async () => {
    const { propose, call, queue, pasta, entries, notes } = await setup();
    const before = [...pasta().blocks];
    const id = (await propose(["spam"])).json.pending.id;
    expect((await call("POST", `/api/admin/pending/${id}/reject`, { note: "not a recipe" })).status).toBe(200);
    expect(pasta().blocks).toEqual(before);
    expect(await queue.list()).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ action: "reject", outcome: "rejected", note: "not a recipe", attempted: ["spam"] });
    expect(notes).toEqual([]);
    expect((await call("POST", `/api/admin/pending/${id}/approve`, {})).status).toBe(404);
  });

  it("queues new recipes; approving adds them, and a duplicate name is caught at both steps", async () => {
    const { call, docs, queue } = await setup();
    expect((await call("POST", "/api/recipes", { title: "Pasta Bake" })).status).toBe(409);
    const r = await call("POST", "/api/recipes", { title: "Soup", markdown: "**Head Chef: Sam**" });
    expect(r.status).toBe(202);
    expect(docs.calls.some((c) => c.startsWith("append"))).toBe(false);
    expect((await call("GET", `/api/admin/pending/${r.json.pending.id}`)).json.pending).toMatchObject({ kind: "add_recipe", title: "Soup" });
    expect((await call("POST", `/api/admin/pending/${r.json.pending.id}/approve`, {})).status).toBe(200);
    expect(docs.byTitle("Soup").blocks).toEqual(["**Head Chef: Sam**"]);

    const again = await call("POST", "/api/recipes", { title: "soup" });
    expect(again.status).toBe(409);
    expect(await queue.list()).toEqual([]);
  });

  it("limits waiting changes per visitor and in total", async () => {
    const perIp = await setup({ perIp: 2 });
    expect((await perIp.propose(["one"])).status).toBe(202);
    expect((await perIp.propose(["two"])).status).toBe(202);
    const third = await perIp.propose(["three"]);
    expect(third.status).toBe(429);
    expect(third.json.error.message).toMatch(/2 changes waiting/);
    expect((await perIp.propose(["other visitor"], "9.9.9.9")).status).toBe(202);
    expect(perIp.entries.at(-2)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("queue_per_ip") });

    const total = await setup({ max: 1 });
    expect((await total.propose(["one"])).status).toBe(202);
    expect((await total.propose(["two"], "2.2.2.2")).status).toBe(429);
  });
});

describe("admin routes", () => {
  it("need the right bearer token, and lock out an IP after 10 missing or wrong ones", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/admin/pending", undefined, { token: null })).status).toBe(401);
    for (let i = 0; i < 9; i++) expect((await call("GET", "/api/admin/pending", undefined, { token: "wrong" })).status).toBe(401);
    expect((await call("GET", "/api/admin/pending", undefined, { token: "wrong" })).status).toBe(429);
    expect((await call("GET", "/api/admin/pending")).status).toBe(429); // even the right token, from that IP
    expect((await call("GET", "/api/admin/pending", undefined, { ip: "5.5.5.5" })).status).toBe(200);
  });

  it("reject ids that aren't queue ids", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/admin/pending/..%2F..%2Fetc")).status).toBe(404);
    expect((await call("POST", "/api/admin/pending/not-an-id/approve", {})).status).toBe(404);
  });

  it("don't exist without the approval queue", async () => {
    const app = createApp({ recipes: new RecipesService({ docs: booklet(), lock: new InMemoryLock(), slug: "fake" }), adminToken: TOKEN });
    const res = await app.request("/api/admin/pending", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});

describe("chat notes without approval", () => {
  it("post after a direct save that changed something, and after a new recipe", async () => {
    const docs = booklet();
    const notes: Array<[string | undefined, string]> = [];
    const app = createApp({ recipes: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake" }), chat: { notify: (id, t) => void notes.push([id, t]) } });
    const method = docs.byTitle("Method");
    const put = (texts: string[]) =>
      app.request(`/api/sections/${method.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: FakeDocs.rev(docs.byTitle("Method")), texts }) });
    expect((await put(["1. Fry.\n2. Add rice.", ""])).status).toBe(200); // unchanged: no note
    expect((await put(["1. Fry well.", ""])).status).toBe(200);
    await app.request("/api/recipes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Stew" }) });
    expect(notes).toEqual([
      [docs.byTitle("Format Recipe").id, 'Recipe updated through Ration Club Recipes: "Format Recipe" › Method.'],
      [undefined, 'New recipe added through Ration Club Recipes: "Stew".'],
    ]);
  });
});
