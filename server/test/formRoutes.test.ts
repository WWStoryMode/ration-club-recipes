import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryLock } from "../src/lock.js";
import { FilePendingQueue } from "../src/queue.js";
import { emptyForm } from "../src/recipeForm.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(withQueue = false) {
  const docs = booklet();
  let queue: FilePendingQueue | undefined;
  if (withQueue) {
    const dir = await mkdtemp(path.join(tmpdir(), "form-"));
    dirs.push(dir);
    queue = new FilePendingQueue(dir);
  }
  const app = createApp({ recipes: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake", cacheMs: 0 }), queue, adminToken: queue ? "t".repeat(40) : undefined });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { docs, call, queue };
}

const values = { ...emptyForm(), headChef: "Mario", helpers: "Noam", ingredients: ["pasta"], method: ["Boil."], date: "2026-09-30" };
const { other: _o, ...visitorValues } = values;

describe("recipe form routes", () => {
  it("GET a recipe includes its form values and whether the form can edit it", async () => {
    const { call, docs } = await setup();
    const pasta = await call("GET", `/api/recipes/${docs.byTitle("Pasta Bake").id}`);
    expect(pasta.json.recipe.form).toMatchObject({
      editable: true,
      rev: FakeDocs.rev(docs.byTitle("Pasta Bake")),
      values: { headChef: "Chef Alpha", helpers: "Helper One, Helper Two", date: "2026-09-30" },
    });
    const fmt = await call("GET", `/api/recipes/${docs.byTitle("Format Recipe").id}`);
    expect(fmt.json.recipe.form).toMatchObject({ editable: false, reason: expect.stringContaining("sub-headings") });
  });

  it("PUT saves the form in the booklet layout", async () => {
    const { call, docs } = await setup();
    const s = docs.byTitle("Pasta Bake");
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: visitorValues });
    expect(r.status).toBe(200);
    expect(docs.byTitle("Pasta Bake").blocks).toEqual(["**Head Chef: Mario**", "**Support: Noam**", "**Ingredients**", "- pasta", "**Method**", "1. Boil.", "30 September 2026"]);
  });

  it("ignores an `other` sent by the browser and keeps the document's own extra text", async () => {
    const { call, docs } = await setup();
    const s = docs.byTitle("Pasta Bake");
    s.blocks.splice(2, 0, "A note from docs.plus.");
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...visitorValues, other: "# injected heading" } });
    expect(r.status).toBe(200);
    expect(s.blocks).toContain("A note from docs.plus.");
    expect(s.blocks.join("\n")).not.toContain("injected");
  });

  it("refuses recipes with sub-headings or media", async () => {
    const { call, docs } = await setup();
    const s = docs.byTitle("Format Recipe");
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: visitorValues });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/only the organisers/);
  });

  it("answers 409 with the latest recipe (including its form) when someone saved first", async () => {
    const { call, docs } = await setup();
    const s = docs.byTitle("Pasta Bake");
    const old = FakeDocs.rev(s);
    s.blocks = ["**Head Chef: Someone Else**"];
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: old, form: visitorValues });
    expect(r.status).toBe(409);
    expect(r.json.error.latest.form.values.headChef).toBe("Someone Else");
    expect(s.blocks).toEqual(["**Head Chef: Someone Else**"]);
  });

  it("POST adds a recipe from form values", async () => {
    const { call, docs } = await setup();
    const r = await call("POST", "/api/recipes", { title: "Soup", form: { ...visitorValues, serves: "20" } });
    expect(r.status).toBe(201);
    expect(docs.byTitle("Soup").blocks).toContain("**Serves: 20**");
  });

  it("with the approval queue, form edits are queued as formatted text", async () => {
    const { call, docs, queue } = await setup(true);
    const s = docs.byTitle("Pasta Bake");
    const before = [...s.blocks];
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: visitorValues });
    expect(r.status).toBe(202);
    expect(s.blocks).toEqual(before);
    const [item] = await queue!.list();
    expect(item).toMatchObject({ kind: "save_section", texts: [expect.stringContaining("**Head Chef: Mario**")] });
  });
});

describe("serving the web page", () => {
  it("serves the built page with a strict CSP, falls back to index.html, and keeps /api JSON", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "web-"));
    dirs.push(root);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>x</title>");
    await writeFile(path.join(root, "assets", "app-abc.js"), "console.log(1)");
    const app = createApp({ recipes: new RecipesService({ docs: booklet(), lock: new InMemoryLock(), slug: "fake" }), webRoot: root });

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<title>x</title>");
    const csp = home.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");

    const js = await app.request("/assets/app-abc.js");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/some/deep/link")).status).toBe(200);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/../secrets")).status).not.toBe(500);

    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
