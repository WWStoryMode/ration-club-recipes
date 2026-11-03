import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NeedsLoginError } from "../src/auth/DocsPlusOAuthProvider.js";
import { DocsPlusError } from "../src/docsPlus.js";
import { InMemoryLock } from "../src/lock.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

function setup(docs = booklet()) {
  const app = createApp({ recipes: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake" }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { docs, call };
}

describe("HTTP API", () => {
  it("GET /api/recipes", async () => {
    const { call } = setup();
    const r = await call("GET", "/api/recipes");
    expect(r.status).toBe(200);
    expect(r.json.recipes.map((x: { title: string }) => x.title)).toEqual(["Pasta Bake", "Format Recipe"]);
  });

  it("GET /api/recipes/:id and 404s", async () => {
    const { call, docs } = setup();
    const ok = await call("GET", `/api/recipes/${docs.byTitle("Pasta Bake").id}`);
    expect(ok.status).toBe(200);
    expect(ok.json.recipe.sections[0].rev).toMatch(/^[0-9a-f]{12}$/);
    expect((await call("GET", "/api/recipes/nope")).status).toBe(404);
    expect((await call("GET", "/api/recipes/bad%20id!")).status).toBe(404);
    expect((await call("GET", "/api/nothing")).status).toBe(404);
  });

  it("PUT /api/sections/:id saves and returns the new rev", async () => {
    const { call, docs } = setup();
    const s = docs.byTitle("Pasta Bake");
    const r = await call("PUT", `/api/sections/${s.id}`, { baseRev: FakeDocs.rev(s), texts: ["**Head Chef: New**"] });
    expect(r.status).toBe(200);
    expect(r.json.section.rev).toBe(FakeDocs.rev(s));
    expect(s.blocks).toEqual(["**Head Chef: New**"]);
  });

  it("PUT conflict returns 409 with the latest version", async () => {
    const { call, docs } = setup();
    const s = docs.byTitle("Pasta Bake");
    const r = await call("PUT", `/api/sections/${s.id}`, { baseRev: "000000000000", texts: ["x"] });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
    expect(r.json.error.latest.rev).toBe(FakeDocs.rev(s));
  });

  it("validates bodies with plain messages", async () => {
    const { call, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    const bad = await call("PUT", `/api/sections/${id}`, { baseRev: "nope", texts: [] });
    expect(bad.status).toBe(422);
    expect(bad.json.error.message).toMatch(/baseRev/);
    expect((await call("PUT", `/api/sections/${id}`, "{not json")).status).toBe(422);
    const heading = await call("PUT", `/api/sections/${id}`, { baseRev: FakeDocs.rev(docs.byTitle("Pasta Bake")), texts: ["# x"] });
    expect(heading.json.error.message).toMatch(/Headings can't be added/);
  });

  it("rejects oversized bodies", async () => {
    const { call, docs } = setup();
    const r = await call("PUT", `/api/sections/${docs.byTitle("Pasta Bake").id}`, { baseRev: "0".repeat(12), texts: ["x".repeat(140_000)] });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/too much text/);
  });

  it("POST /api/recipes creates a recipe (201) and refuses duplicates (409)", async () => {
    const { call } = setup();
    const r = await call("POST", "/api/recipes", { title: "Lentil Soup" });
    expect(r.status).toBe(201);
    expect(r.json.recipe).toMatchObject({ title: "Lentil Soup", id: expect.any(String) });
    expect((await call("POST", "/api/recipes", { title: "lentil soup" })).status).toBe(409);
  });

  it("maps docs.plus failures to plain messages without leaking internals", async () => {
    const cases: Array<[unknown, number, RegExp]> = [
      [new DocsPlusError("rate_limited", "get_outline", "Rate limit"), 429, /wait a minute/],
      [new DocsPlusError("not_owner", "get_outline", "secret detail"), 503, /can't be changed right now/],
      [new NeedsLoginError(), 503, /can't be changed right now/],
      [new Error("socket hang up at 10.0.0.1"), 500, /went wrong on our side/],
    ];
    for (const [err, status, msg] of cases) {
      const docs = booklet();
      docs.getOutline = async () => {
        throw err;
      };
      const r = await setup(docs).call("GET", "/api/recipes");
      expect(r.status).toBe(status);
      expect(r.json.error.message).toMatch(msg);
      expect(JSON.stringify(r.json)).not.toMatch(/secret detail|10\.0\.0\.1|NeedsLogin/);
    }
  });

  it("maps a media refusal to the organisers message", async () => {
    const docs = booklet();
    docs.editBlocks = async () => {
      throw new DocsPlusError("invalid_input", "edit_blocks", "remove_blocks: block(s) 4 hold a picture, video or file, and docs.plus never deletes media for an AI app.");
    };
    const s = docs.byTitle("Pasta Bake");
    const r = await setup(docs).call("PUT", `/api/sections/${s.id}`, { baseRev: FakeDocs.rev(s), texts: ["x"] });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/Pictures and videos can only be changed by the booklet's organisers/);
  });
});
