import { describe, expect, it } from "vitest";
import { DocsPlusError } from "../src/docsPlus.js";
import { ApiError } from "../src/errors.js";
import { InMemoryLock } from "../src/lock.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

function setup(docs = booklet(), now = () => 0) {
  return { docs, svc: new RecipesService({ docs, lock: new InMemoryLock(), slug: "fake", now }) };
}
const rev = (docs: FakeDocs, title: string) => FakeDocs.rev(docs.byTitle(title));
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  if (msg) expect((err as ApiError).message).toMatch(msg);
  return err as ApiError;
}

describe("reading", () => {
  it("lists the booklet's recipes with their subsections", async () => {
    const { svc } = setup();
    const list = await svc.listRecipes();
    expect(list.map((r) => r.title)).toEqual(["Pasta Bake", "Format Recipe"]);
    expect(list[1]!.subsections.map((s) => [s.title, s.level])).toEqual([["Ingredients", 4], ["Method", 4]]);
  });

  it("returns a recipe with fields and text/media parts", async () => {
    const { svc, docs } = setup();
    const r = await svc.getRecipe(docs.byTitle("Format Recipe").id);
    expect(r.fields).toEqual({ headChef: "Chef Echo", date: "3 February 2027" });
    expect(r.sections.map((s) => s.title)).toEqual(["Format Recipe", "Ingredients", "Method"]);
    expect(r.sections[0]!.parts).toEqual([
      { type: "text", markdown: "**Head Chef: Chef Echo**\n\n3 February 2027" },
      { type: "media", kind: "image" },
      { type: "text", markdown: "Caption under the image" },
    ]);
    expect(r.sections[2]!.parts).toEqual([
      { type: "text", markdown: "1. Fry.\n2. Add rice." },
      { type: "media", kind: "youtube" },
      { type: "text", markdown: "" },
    ]);
    expect(r.sections[1]!.hasMedia).toBe(false);
  });

  it("drops empty blocks from the editable text", async () => {
    const { svc, docs } = setup();
    const r = await svc.getRecipe(docs.byTitle("Pasta Bake").id);
    expect(r.sections[0]!.parts).toEqual([{ type: "text", markdown: "**Head Chef: Chef Alpha**\n\n**Support: Helper One, Helper Two**\n\n30 September 2026" }]);
  });

  it("404s for the intro, for subsections as recipes, and for unknown ids", async () => {
    const { svc, docs } = setup();
    await rejects(svc.getRecipe(docs.sections[0]!.id), "not_found");
    await rejects(svc.getRecipe(docs.byTitle("Ingredients").id), "not_found");
    await rejects(svc.getRecipe("nope"), "not_found");
  });

  it("caches reads briefly to save docs.plus calls", async () => {
    let t = 0;
    const { svc, docs } = setup(booklet(), () => t);
    await svc.listRecipes();
    await svc.listRecipes();
    expect(docs.calls.filter((c) => c === "getOutline")).toHaveLength(1);
    t = 10_001;
    await svc.listRecipes();
    expect(docs.calls.filter((c) => c === "getOutline")).toHaveLength(2);
  });
});

describe("saving a section", () => {
  it("replaces all text in a section without media", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    const { section: v, before, changed, recipe } = await svc.saveSection(id, rev(docs, "Pasta Bake"), ["**Head Chef: Chef Alpha**\r\n\r\n\r\n- pasta\n- cheese  "]);
    expect(changed).toBe(true);
    expect(recipe).toEqual({ id, title: "Pasta Bake" });
    expect(before.parts[0]).toMatchObject({ markdown: expect.stringContaining("Helper One") });
    expect(docs.byTitle("Pasta Bake").blocks).toEqual(["**Head Chef: Chef Alpha**", "- pasta\n- cheese"]);
    expect(v.rev).toBe(rev(docs, "Pasta Bake"));
    expect(docs.calls.filter((c) => c.startsWith("edit"))).toEqual([`edit:${id}:0:5`]);
  });

  it("edits text around media bottom-up and never touches the media", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Format Recipe").id;
    await svc.saveSection(id, rev(docs, "Format Recipe"), ["**Head Chef: Chef Echo Edited**", "New caption\n\nSecond line"]);
    expect(docs.byTitle("Format Recipe").blocks).toEqual(["**Head Chef: Chef Echo Edited**", "\\[image\\]", "New caption", "Second line"]);
    // last text part first (after the image at block 3), then the first part
    expect(docs.calls.filter((c) => c.startsWith("edit"))).toEqual([`edit:${id}:3:1`, `edit:${id}:0:2`]);
  });

  it("adds text into an empty part after media", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Method").id;
    await svc.saveSection(id, rev(docs, "Method"), ["1. Fry.\n2. Add rice.", "Serve hot."]);
    expect(docs.byTitle("Method").blocks).toEqual(["1. Fry.\n2. Add rice.", "\\[youtube\\]", "Serve hot."]);
  });

  it("writes nothing when nothing changed", async () => {
    const { svc, docs } = setup();
    const r = await svc.saveSection(docs.byTitle("Pasta Bake").id, rev(docs, "Pasta Bake"), ["**Head Chef: Chef Alpha**\n\n**Support: Helper One, Helper Two**\n\n30 September 2026"]);
    expect(docs.calls.some((c) => c.startsWith("edit"))).toBe(false);
    expect(r.changed).toBe(false);
  });

  it("refuses with the latest version if the section changed since the visitor loaded it", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    const old = rev(docs, "Pasta Bake");
    docs.byTitle("Pasta Bake").blocks.push("Someone else's line");
    const err = await rejects(svc.saveSection(id, old, ["mine"]), "conflict", /Someone else changed this recipe/);
    expect((err.extra.latest as { parts: unknown[] }).parts).toEqual([{ type: "text", markdown: expect.stringContaining("Someone else's line") }]);
    expect(docs.calls.some((c) => c.startsWith("edit"))).toBe(false);
  });

  it("retries once on a stale rev, and succeeds if the content is unchanged", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    let thrown = false;
    const real = docs.editBlocks.bind(docs);
    docs.editBlocks = async (p) => {
      if (!thrown) {
        thrown = true;
        throw new DocsPlusError("stale_rev", "edit_blocks", "The section changed since you read it.");
      }
      return real(p);
    };
    await svc.saveSection(id, rev(docs, "Pasta Bake"), ["retried"]);
    expect(docs.byTitle("Pasta Bake").blocks).toEqual(["retried"]);
  });

  it("turns a stale rev into a conflict when someone else really wrote in between", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    docs.beforeEdit = (n) => {
      if (n === 0) docs.byTitle("Pasta Bake").blocks.push("racing editor");
    };
    await rejects(svc.saveSection(id, rev(docs, "Pasta Bake"), ["mine"]), "conflict");
    expect(docs.byTitle("Pasta Bake").blocks.at(-1)).toBe("racing editor");
  });

  it("refuses a wrong number of text parts", async () => {
    const { svc, docs } = setup();
    await rejects(svc.saveSection(docs.byTitle("Format Recipe").id, rev(docs, "Format Recipe"), ["only one"]), "invalid", /2 text part/);
  });

  it("refuses to edit the intro or unknown sections", async () => {
    const { svc, docs } = setup();
    await rejects(svc.saveSection(docs.sections[0]!.id, FakeDocs.rev(docs.sections[0]!), ["x"]), "not_found");
  });

  it.each([
    ["#### New heading", /Headings can't be added/],
    ["![cat](https://example.com/cat.png)", /Pictures can't be added/],
    ["look \\[image\\] here", /reserved for pictures/],
    ["[youtube]", /reserved for pictures/],
    ["https://www.youtube.com/watch?v=abc", /link on a line by itself/],
    ["```mermaid\nflowchart LR\n```", /Code blocks/],
    ["<script>alert(1)</script>", /HTML tags/],
    ["x".repeat(20_001), /too long/],
  ])("refuses visitor text: %s", async (text, msg) => {
    const { svc, docs } = setup();
    await rejects(svc.saveSection(docs.byTitle("Pasta Bake").id, rev(docs, "Pasta Bake"), [text]), "invalid", msg);
    expect(docs.calls.some((c) => c.startsWith("edit"))).toBe(false);
  });

  it("allows ordinary recipe markdown, including a link inside a sentence", async () => {
    const { svc, docs } = setup();
    await svc.saveSection(docs.byTitle("Pasta Bake").id, rev(docs, "Pasta Bake"), ["**Ingredients**\n\n- 500 g pasta\n\nBased on https://example.com/recipe, with *less* salt."]);
    expect(docs.byTitle("Pasta Bake").blocks).toHaveLength(3);
  });

  it("serialises concurrent saves per document", async () => {
    const { svc, docs } = setup();
    const id = docs.byTitle("Pasta Bake").id;
    const base = rev(docs, "Pasta Bake");
    const results = await Promise.allSettled([svc.saveSection(id, base, ["first"]), svc.saveSection(id, base, ["second"])]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(((results[1] as PromiseRejectedResult).reason as ApiError).code).toBe("conflict");
    expect(docs.byTitle("Pasta Bake").blocks).toEqual(["first"]);
  });
});

describe("adding a recipe", () => {
  it("appends '### **Title**' under the booklet and returns it", async () => {
    const { svc, docs } = setup();
    const r = await svc.addRecipe("  Lentil   Soup ", "**Head Chef: Chef Zulu**\n\n**Ingredients**\n\n- lentils");
    expect(r.title).toBe("Lentil Soup");
    expect(docs.sections.at(-1)).toMatchObject({ heading: "### **Lentil Soup**", blocks: ["**Head Chef: Chef Zulu**", "**Ingredients**", "- lentils"] });
    expect((await svc.listRecipes()).map((x) => x.title)).toContain("Lentil Soup");
  });

  it("uses the booklet template when no text is given", async () => {
    const { svc, docs } = setup();
    await svc.addRecipe("Empty One", "");
    expect(docs.sections.at(-1)!.blocks).toEqual(["**Head Chef: ???**", "**Support: ???**", "**Ingredients**", "**Method**"]);
  });

  it("refuses duplicates, case-insensitively", async () => {
    const { svc } = setup();
    await rejects(svc.addRecipe("pasta bake", ""), "conflict", /already a recipe called/);
  });

  it.each([[""], ["# Hack"], ["**Bold**"], ["a".repeat(101)]])("refuses the title %j", async (t) => {
    const { svc, docs } = setup();
    await rejects(svc.addRecipe(t, ""), "invalid");
    expect(docs.calls.some((c) => c.startsWith("append"))).toBe(false);
  });

  it("refuses to append when another top-level section comes after the booklet", async () => {
    const docs = booklet();
    docs.sections.push({ id: "extra", heading: "# ", blocks: [] });
    const { svc } = setup(docs);
    await rejects(svc.addRecipe("New", ""), "unavailable");
    expect(docs.calls.some((c) => c.startsWith("append"))).toBe(false);
  });

  it("never retries an unconfirmed append", async () => {
    const docs = booklet();
    docs.failAppend = new DocsPlusError("unconfirmed_write", "append_to_document", "docs.plus could not confirm the write.");
    const { svc } = setup(docs);
    const err = await svc.addRecipe("New", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocsPlusError);
    expect(docs.calls.filter((c) => c.startsWith("append"))).toHaveLength(1);
  });
});
