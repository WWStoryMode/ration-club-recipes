import { describe, expect, it } from "vitest";
import type { Block } from "../src/docsPlus.js";
import { ApiError } from "../src/errors.js";
import { emptyForm, escapeText, formatDate, formatRecipe, parseDate, parseRecipe, unescapeText, type RecipeForm } from "../src/recipeForm.js";
import { checkVisitorMarkdown } from "../src/validate.js";

const blocks = (...md: string[]): Block[] => md.map((m, i) => ({ n: i + 1, markdown: m, isEmpty: m.trim() === "", isMedia: false }));
/** What docs.plus gives back for a body we wrote: one block per paragraph. */
const roundTrip = (md: string) => parseRecipe(blocks(...md.split(/\n\n/)));

const full: RecipeForm = {
  headChef: "Mario",
  helpers: "William, Noam",
  date: "2026-09-30",
  serves: "30",
  cost: "about £25",
  ingredients: ["1 kg pasta", "2 tins tomatoes"],
  method: ["Boil the pasta.", "Bake for 20 minutes."],
  tips: ["Any short pasta works."],
  story: "Mario's family recipe.\n\nWe made it for the welcome dinner.",
  other: "",
  photos: [],
};

describe("recipe form", () => {
  it("formats the booklet layout", () => {
    expect(formatRecipe(full)).toBe(
      [
        "**Head Chef: Mario**",
        "**Support: William, Noam**",
        "**Serves: 30**",
        "**Cost: about £25**",
        "**Ingredients**",
        "- 1 kg pasta\n- 2 tins tomatoes",
        "**Method**",
        "1. Boil the pasta.\n2. Bake for 20 minutes.",
        "**Tips & substitutions**",
        "- Any short pasta works.",
        "**Story**",
        "Mario's family recipe.",
        "We made it for the welcome dinner.",
        "30 September 2026",
      ].join("\n\n"),
    );
  });

  it("keeps the template look when empty, and leaves optional fields out", () => {
    expect(formatRecipe(emptyForm())).toBe("**Head Chef: ???**\n\n**Support: ???**\n\n**Ingredients**\n\n**Method**");
  });

  it("round-trips through the document", () => {
    expect(roundTrip(formatRecipe(full))).toEqual(full);
  });

  it("reads the real booklet's recipes, typos and placeholders included", () => {
    expect(parseRecipe(blocks("**Head Chef: Anchit**", "**Support: ???**", "**Ingridients**", "**Method**", "23 September 2026"))).toEqual({
      ...emptyForm(),
      headChef: "Anchit",
      date: "2026-09-23",
    });
    expect(parseRecipe(blocks("**Head Chef: William**"))).toEqual({ ...emptyForm(), headChef: "William" });
  });

  it("keeps text that fits no field in `other`, and writes it back unchanged", () => {
    const f = parseRecipe(blocks("**Head Chef: A**", "A note someone typed in docs.plus.", "**Method**", "1. Stir."));
    expect(f.other).toBe("A note someone typed in docs.plus.");
    expect(f.method).toEqual(["Stir."]);
    expect(formatRecipe(f)).toContain("A note someone typed in docs.plus.");
  });

  it("makes visitor text literal: no headings, bold, links, HTML or list tricks", () => {
    const evil: RecipeForm = {
      ...emptyForm(),
      headChef: "**Boss** <b>x</b>",
      ingredients: ["# heading", "[click](https://evil.example)", "![img](x.png)"],
      story: "# Big title\n- not a list\n1. not a step\n> not a quote",
    };
    const md = formatRecipe(evil);
    expect(() => checkVisitorMarkdown(md)).not.toThrow();
    expect(md).not.toMatch(/^#/m);
    expect(roundTrip(md)).toMatchObject({ headChef: "**Boss** <b>x</b>", ingredients: ["# heading", "[click](https://evil.example)", "![img](x.png)"] });
  });

  it("tidies lines: trims, drops blanks, splits pasted multi-line entries", () => {
    const md = formatRecipe({ ...emptyForm(), ingredients: ["  rice  ", "", "onions\ngarlic"] });
    expect(md).toContain("- rice\n- onions\n- garlic");
  });

  it("refuses values over the limits and bad dates, with plain messages", () => {
    const bad = (f: Partial<RecipeForm>, msg: RegExp) => {
      try {
        formatRecipe({ ...emptyForm(), ...f });
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as Error).message).toMatch(msg);
      }
    };
    bad({ serves: "x".repeat(101) }, /Serves can be at most 100/);
    bad({ method: Array(101).fill("step") }, /Method: please keep it to 100 lines/);
    bad({ tips: ["x".repeat(501)] }, /each line can be at most 500/);
    bad({ date: "2026-13-01" }, /pick the date/);
  });

  it("converts dates both ways", () => {
    expect(formatDate("2026-09-03")).toBe("3 September 2026");
    expect(parseDate("3 September 2026")).toBe("2026-09-03");
    expect(parseDate("23 September 2026 (Welcome dinner)")).toBe("");
    expect(formatDate("nonsense")).toBe("");
  });

  it("escape and unescape are inverses for plain text", () => {
    for (const t of ["a*b_c", "1. step", "- item", "#tag", "x | y ~ z", "back\\slash", "<tag>"]) expect(unescapeText(escapeText(t))).toBe(t);
  });

  it("reads back what docs.plus actually returned in the live test (entities, autolinks, unescaped #)", () => {
    // Blocks exactly as read_document returned them after saving the form below (2026-11-03, test doc).
    const live = blocks(
      "**Head Chef: Chef \\*Star\\* &amp; Co &lt;b&gt;**",
      "**Support: Ana, Bo\\_b, C#**",
      "**Serves: 30 people**",
      "**Cost: about £25 (£0.83 each)**",
      "**Ingredients**",
      "- 1 kg \\[basmati\\] rice\n- 2 tins tomatoes | chopped\n- - dash of salt\n- 1. olive oil",
      "**Method**",
      "1. Rinse the rice \\~3 times.\n2. Fry onions until \\*golden\\*.\n3. See [https://example.org/tips](https://example.org/tips) for more.",
      "**Tips &amp; substitutions**",
      "- Swap rice for couscous\n- Use \\\\ backslash? fine",
      "**Story**",
      "# Not a heading",
      "Made at the \\*welcome\\* dinner &gt; 50 people.\n1. not a list",
      "7 October 2026",
    );
    expect(parseRecipe(live)).toEqual({
      headChef: "Chef *Star* & Co <b>",
      helpers: "Ana, Bo_b, C#",
      date: "2026-10-07",
      serves: "30 people",
      cost: "about £25 (£0.83 each)",
      ingredients: ["1 kg [basmati] rice", "2 tins tomatoes | chopped", "- dash of salt", "1. olive oil"],
      method: ["Rinse the rice ~3 times.", "Fry onions until *golden*.", "See https://example.org/tips for more."],
      tips: ["Swap rice for couscous", "Use \\ backslash? fine"],
      story: "# Not a heading\n\nMade at the *welcome* dinner > 50 people.\n1. not a list",
      other: "",
      photos: [],
    });
  });

  it("turns a named link back into readable text, and decodes a typed entity only once", () => {
    expect(parseRecipe(blocks("**Method**", "1. See [the tips](https://example.org) first.")).method).toEqual(["See the tips (https://example.org) first."]);
    expect(parseRecipe(blocks("**Head Chef: A &amp;amp; B**")).headChef).toBe("A &amp; B");
  });

  it("escapes a leading # in carried-over text so it can't become a heading", () => {
    const md = formatRecipe({ ...emptyForm(), other: "# literal hash line" });
    expect(md).toContain("\\# literal hash line");
    expect(() => checkVisitorMarkdown(md)).not.toThrow();
  });

  it("reads labels typed without bold, with one item per paragraph (the real risotto recipe)", () => {
    const f = parseRecipe(blocks("**Head Chef: Leo**", "**Support: Ness, Gideon**", "Ingredients", "Parsely", "Risotto", "Onions", "28 October 2026"));
    expect(f).toMatchObject({ headChef: "Leo", helpers: "Ness, Gideon", ingredients: ["Parsely", "Risotto", "Onions"], date: "2026-10-28", other: "" });
  });
});
