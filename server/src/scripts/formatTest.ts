/**
 * pnpm format-test: test layout changes and media on a throwaway "Format Test Recipe" in the TEST doc.
 *
 *  1. Append the recipe in the booklet's current format (bold "Ingredients"/"Method" paragraphs).
 *  2. Convert it to real #### Ingredients / #### Method subsections (edit_blocks, headings at the end).
 *  3. Add an image to the recipe section and a YouTube link to its Method subsection.
 *  4. Check media reads back as placeholders, can't be removed, and survives editing the blocks around it.
 *
 * Headings and media can't be removed through MCP, so this runs ONCE. If the recipe exists, it only reports.
 * Refuses unless DOC_SLUG is the test doc owned by you.
 */
import { config } from "../config.js";
import { DocsPlus, DocsPlusError, flattenOutline, type OutlineNode, type Section } from "../docsPlus.js";
import { connect, defaultStore, makeProvider } from "../mcp.js";
import { TEST_DOC_TITLE } from "../seed/testRecipes.js";

const RECIPE = "Format Test Recipe";
const IMAGE_URL = "https://placehold.co/600x400.png";
const YOUTUBE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo"

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const show = (s: Section) =>
  `${s.headingMarkdown}  (rev ${s.rev})\n` + s.blocks.map((b) => `[${b.n}]${b.isMedia ? " (media)" : ""} ${JSON.stringify(b.markdown)}`).join("\n");

async function main() {
  const { client } = await connect(makeProvider(defaultStore()));
  const dp = new DocsPlus(client, config.docSlug);
  const raw = () => JSON.stringify({ text: dp.lastResult?.text, structuredContent: dp.lastResult?.structuredContent });
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const d = await fn();
      console.log(`PASS  ${name}${d ? `\n      ${d.replace(/\n/g, "\n      ")}` : ""}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${name}\n      ${(err instanceof Error ? err.message : String(err)).replace(/\n/g, "\n      ")}`);
    }
  };
  const find = async (): Promise<OutlineNode | undefined> =>
    flattenOutline((await dp.getOutline()).nodes).find((n) => n.title === RECIPE && n.level === 3);

  // --- Guard ---------------------------------------------------------------------------------
  const outline = await dp.getOutline();
  if (!outline.ownedByYou || outline.nodes[0]?.title !== TEST_DOC_TITLE) {
    throw new Error(`Refusing: ${config.docSlug} is not our TEST doc.`);
  }

  const existing = await find();
  if (existing) console.log(`"${RECIPE}" already exists: steps already done are skipped.\n`);

  // --- 1. Append in the current booklet format -------------------------------------------------
  if (!existing) await step("1. append the recipe in the current format (bold Ingredients/Method paragraphs)", async () => {
    await dp.appendRecipe(
      `**${RECIPE}**`,
      [
        "**Head Chef: Chef Echo**",
        "**Support: Helper Four**",
        "**Ingredients**",
        "- 1 kg rice\n- 2 onions",
        "**Method**",
        "1. Fry the onions.\n2. Add rice and water.",
        "3 February 2027",
      ].join("\n\n"),
    );
    const node = await find();
    check(!!node, "recipe not found after append");
    const s = await dp.readSection(node!.sectionId!);
    check(s.headingMarkdown === `### **${RECIPE}**`, `heading is ${s.headingMarkdown}`);
    return show(s);
  });

  const node = await find();
  if (!node) throw new Error("Cannot continue without the recipe");
  const id = node.sectionId!;

  // --- 2. Convert to #### subsections ----------------------------------------------------------
  if (!node.children.length) await step("2. convert to #### Ingredients / #### Method subsections (replace blocks 3–7, headings at the end)", async () => {
    const s = await dp.readSection(id);
    // Keep Head Chef + Support (blocks 1–2). Move the date up, then the subsections last, since new headings must come at the end.
    await dp.editBlocks({
      sectionId: id,
      rev: s.rev,
      afterBlock: 2,
      removeBlocks: s.blocks.length - 2,
      markdown: [
        "3 February 2027",
        "#### Ingredients",
        "- 1 kg rice\n- 2 onions",
        "#### Method",
        "1. Fry the onions.\n2. Add rice and water.",
      ].join("\n\n"),
    });
    const res = raw();
    const after = await find();
    const kids = after?.children ?? [];
    check(
      JSON.stringify(kids.map((k) => [k.title, k.level])) === JSON.stringify([["Ingredients", 4], ["Method", 4]]),
      `subsections are ${JSON.stringify(kids.map((k) => [k.title, k.level]))}`,
    );
    const parts = [show(await dp.readSection(id)), ...(await Promise.all(kids.map(async (k) => show(await dp.readSection(k.sectionId!)))))];
    return `raw: ${res}\n\n${parts.join("\n\n")}`;
  });

  const kids = (await find())?.children ?? [];
  const method = kids.find((k) => k.title === "Method");

  // --- 3. Add media ----------------------------------------------------------------------------
  const hasMedia = async (sid: string) => (await dp.readSection(sid)).blocks.some((b) => b.isMedia);
  if (!(await hasMedia(id))) await step("3a. add an image to the recipe section (edit_blocks, markdown image syntax)", async () => {
    const s = await dp.readSection(id);
    await dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: `![Format test placeholder](${IMAGE_URL})` });
    const res = raw();
    const a = await dp.readSection(id);
    check(a.blocks.some((b) => b.isMedia), `no media block after insert:\n${show(a)}`);
    return `raw: ${res}\n${show(a)}`;
  });

  if (!method?.sectionId || !(await hasMedia(method.sectionId))) await step("3b. add a YouTube link (alone on a line) to the Method subsection", async () => {
    check(!!method?.sectionId, "Method subsection missing");
    const s = await dp.readSection(method!.sectionId!);
    await dp.editBlocks({ sectionId: s.sectionId, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: YOUTUBE_URL });
    const a = await dp.readSection(s.sectionId);
    check(a.blocks.some((b) => b.isMedia), `link did not become a player (no media placeholder):\n${show(a)}`);
    return show(a);
  });

  // --- 4. Media behaviour ----------------------------------------------------------------------
  await step("4a. removing a media block is refused", async () => {
    const s = await dp.readSection(id);
    const img = s.blocks.find((b) => b.isMedia);
    check(!!img, "no media block to try");
    try {
      await dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: img!.n - 1, removeBlocks: 1, markdown: "" });
    } catch (err) {
      if (err instanceof DocsPlusError) return `kind=${err.kind}  text=${JSON.stringify(err.message)}`;
      throw err;
    }
    throw new Error(`removal was NOT refused: ${raw()}`);
  });

  await step("4b. edit the text blocks around the image (PUT pattern skipping media); image survives", async () => {
    const s = await dp.readSection(id);
    const firstMedia = s.blocks.findIndex((b) => b.isMedia);
    check(firstMedia > 0, "expected text blocks before the image");
    await dp.editBlocks({
      sectionId: id,
      rev: s.rev,
      afterBlock: 0,
      removeBlocks: firstMedia, // all blocks before the image
      markdown: "**Head Chef: Chef Echo Edited**\n\n**Support: Helper Four, Helper Five**\n\n3 February 2027",
    });
    const a = await dp.readSection(id);
    check(a.blocks[0]?.markdown === "**Head Chef: Chef Echo Edited**", `block 1 is ${JSON.stringify(a.blocks[0]?.markdown)}`);
    check(a.blocks.filter((b) => b.isMedia).length === s.blocks.filter((b) => b.isMedia).length, "media count changed");
    return show(a);
  });

  await step("4c. typed text '[image]' vs real media: can they be told apart?", async () => {
    // Literal text that only LOOKS like a placeholder. It is plain text, so it can be removed again.
    const s = await dp.readSection(id);
    await dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: "\\[image\\]" });
    const a = await dp.readSection(id);
    const typed = a.blocks.at(-1)!;
    const real = a.blocks.find((b) => b.isMedia && b.n !== typed.n);
    const out = `typed text reads as ${JSON.stringify(typed.markdown)}; real image reads as ${JSON.stringify(real?.markdown)}`;
    let removable: string;
    try {
      await dp.editBlocks({ sectionId: id, rev: a.rev, afterBlock: typed.n - 1, removeBlocks: 1, markdown: "" });
      removable = "typed text block removed OK (so edit_blocks knows the difference)";
    } catch (err) {
      removable = `typed text removal refused: ${err instanceof Error ? err.message : err}`;
    }
    const end = await dp.readSection(id);
    check(end.blocks.length === a.blocks.length - 1, `typed block still there:\n${show(end)}\n${removable}`);
    return `${out}\nsame string: ${typed.markdown === real?.markdown}\n${removable}`;
  });

  console.log(`\n${failures ? `${failures} FAILED` : "All format tests passed."}`);
  await client.close();
}

main().then(
  () => process.exit(failures ? 1 : 0),
  (err) => {
    console.error(`format-test aborted: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
