/**
 * pnpm write-test [--append-again]: exercise every write path against the fictional TEST doc and
 * print the server's real responses, so parsers and error mapping can be checked against reality.
 *
 * Safety: refuses unless DOC_SLUG is owned by you AND its title is the test doc title.
 * It edits "Mystery Stew" and restores its original blocks at the end.
 * appendRecipe adds a heading that MCP can never remove, so it runs once. A rerun skips it
 * unless --append-again is passed.
 */
import { config } from "../config.js";
import { classifyToolError, DocsPlus, DocsPlusError, flattenOutline, type Section } from "../docsPlus.js";
import { connect, defaultStore, makeProvider } from "../mcp.js";
import { TEST_DOC_TITLE } from "../seed/testRecipes.js";

const TARGET = "Mystery Stew";
const APPENDED = "Write Test Recipe";

let failures = 0;
const log = (status: string, name: string, detail = "") => console.log(`${status.padEnd(5)} ${name}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
const check = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function main() {
  const { client } = await connect(makeProvider(defaultStore()));
  const dp = new DocsPlus(client, config.docSlug);
  const raw = () => JSON.stringify({ text: dp.lastResult?.text, structuredContent: dp.lastResult?.structuredContent });

  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      log("PASS", name, (await fn()) ?? "");
    } catch (err) {
      failures++;
      log("FAIL", name, err instanceof Error ? err.message : String(err));
    }
  };
  /** Runs fn, which must be refused. Records the exact refusal text and its classified kind. */
  const refused = (name: string, want: DocsPlusError["kind"] | "any", fn: () => Promise<unknown>) =>
    step(name, async () => {
      try {
        await fn();
      } catch (err) {
        if (!(err instanceof DocsPlusError)) throw err;
        check(want === "any" || err.kind === want, `expected ${want}, classified as ${err.kind}: ${err.message}`);
        return `kind=${err.kind}  text=${JSON.stringify(err.message)}`;
      }
      throw new Error(`expected a refusal, but the write succeeded: ${raw()}`);
    });

  // --- Safety guard --------------------------------------------------------------------------
  const outline = await dp.getOutline();
  const root = outline.nodes[0];
  if (!outline.ownedByYou || root?.title !== TEST_DOC_TITLE) {
    throw new Error(`Refusing: ${config.docSlug} is not our TEST doc (owned=${outline.ownedByYou}, title=${root?.title}).`);
  }
  const node = flattenOutline(outline.nodes).find((n) => n.title === TARGET);
  if (!node?.sectionId) throw new Error(`"${TARGET}" not found in the test doc`);
  const id = node.sectionId;
  console.log(`Test doc ${config.docSlug} (owned by you). Target section "${TARGET}" ${id}\n`);

  const original: Section = await dp.readSection(id);
  const originalBlocks = original.blocks.map((b) => b.markdown);
  let s = original;

  // --- replace_text -----------------------------------------------------------------------
  await step("replace_text: words inside a bold paragraph, returns new rev", async () => {
    const rev = await dp.replaceText({ sectionId: id, rev: s.rev, oldText: "Charlie", newText: "Delta" });
    const res = raw();
    s = await dp.readSection(id);
    check(rev === s.rev, `returned rev ${rev} != re-read rev ${s.rev}`);
    check(s.blocks[0]?.markdown === "**Head Chef: Chef Delta**", `block 1 is ${JSON.stringify(s.blocks[0]?.markdown)} (bold lost?)`);
    check(s.blocks.length === original.blocks.length, "block count changed");
    return `rev ${original.rev} → ${rev}\nraw: ${res}`;
  });

  // Known docs.plus behaviour (found 2026-11-02): text added only at the END of a bold run comes out unbolded.
  await step("NOTE replace_text: appending at the end of a bold run (recorded, not asserted)", async () => {
    await dp.replaceText({ sectionId: id, rev: s.rev, oldText: "Chef Delta", newText: "Chef Delta Tested" });
    s = await dp.readSection(id);
    return `result: ${JSON.stringify(s.blocks[0]?.markdown)}`;
  });

  await refused("replace_text with a stale rev", "stale_rev", () =>
    dp.replaceText({ sectionId: id, rev: original.rev, oldText: "Delta", newText: "X" }),
  );
  await refused("replace_text: old_text not present", "any", () =>
    dp.replaceText({ sectionId: id, rev: s.rev, oldText: "no such words here", newText: "X" }),
  );
  await refused("replace_text: old_text appears twice ('Chef' in 'Head Chef: Chef Delta')", "any", () =>
    dp.replaceText({ sectionId: id, rev: s.rev, oldText: "Chef", newText: "Cook" }),
  );

  // --- edit_blocks ------------------------------------------------------------------------
  await step("edit_blocks: insert blocks at the end (after_block = last, remove 0)", async () => {
    const before = s;
    await dp.editBlocks({
      sectionId: id,
      rev: s.rev,
      afterBlock: s.blocks.length,
      removeBlocks: 0,
      markdown: "**Ingredients**\n\n- 1 mystery ingredient\n- 2 surprises\n\n**Method**\n\n1. Stir.\n2. Wait.",
    });
    const res = raw();
    s = await dp.readSection(id);
    check(s.rev !== before.rev, "rev did not change");
    check(s.blocks.length === before.blocks.length + 4, `expected ${before.blocks.length + 4} blocks, got ${s.blocks.length}`);
    check(s.blocks.at(-1)?.markdown === "1. Stir.\n2. Wait.", `last block is ${JSON.stringify(s.blocks.at(-1)?.markdown)}`);
    return `blocks ${before.blocks.length} → ${s.blocks.length}, rev ${before.rev} → ${s.rev}\nraw: ${res}`;
  });

  await refused("edit_blocks with a stale rev", "stale_rev", () =>
    dp.editBlocks({ sectionId: id, rev: original.rev, afterBlock: 0, removeBlocks: 0, markdown: "x" }),
  );
  await refused("edit_blocks: heading not deeper than the section (### in a ### section)", "any", () =>
    dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: "### Not allowed" }),
  );
  await refused("edit_blocks: a # heading", "any", () =>
    dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: "# Not allowed" }),
  );

  // PUT /api/sections pattern: replace ALL blocks with new body. Here the new body is the original, which also restores it.
  await step("edit_blocks: replace the whole body (after_block 0, remove all) = restore original", async () => {
    await dp.editBlocks({ sectionId: id, rev: s.rev, afterBlock: 0, removeBlocks: s.blocks.length, markdown: originalBlocks.join("\n\n") });
    s = await dp.readSection(id);
    check(JSON.stringify(s.blocks.map((b) => b.markdown)) === JSON.stringify(originalBlocks), `restored blocks differ: ${JSON.stringify(s.blocks.map((b) => b.markdown))}`);
    check(s.headingMarkdown === original.headingMarkdown, "heading changed");
    return `restored ${s.blocks.length} blocks, rev ${s.rev}`;
  });

  // --- append_to_document -----------------------------------------------------------------
  const already = flattenOutline((await dp.getOutline()).nodes).some((n) => n.title === APPENDED);
  if (already && !process.argv.includes("--append-again")) {
    log("SKIP", `append_to_document: "${APPENDED}" already exists (headings can't be removed). Use --append-again.`);
  } else {
    await step("append_to_document: new ### recipe lands under the doc's # heading", async () => {
      await dp.appendRecipe(APPENDED, "**Head Chef: Chef Delta**\n\n**Support: ???**\n\n1 January 2027");
      const res = raw();
      const after = await dp.getOutline();
      const added = after.nodes[0]?.children.filter((c) => c.title === APPENDED) ?? [];
      check(added.length >= 1, `"${APPENDED}" not found under the # heading: ${JSON.stringify(after.nodes.map((n) => n.title))}`);
      check(added.at(-1)!.level === 3, `level ${added.at(-1)!.level}`);
      const sec = await dp.readSection(added.at(-1)!.sectionId!);
      return `added at level 3 under "${after.nodes[0]!.title}", ${sec.blocks.length} blocks\nraw: ${res}`;
    });
  }
  await refused("append_to_document: a # heading is refused (sent raw, bypassing the wrapper's check)", "any", async () => {
    const res = await client.callTool({ name: "append_to_document", arguments: { slug: config.docSlug, markdown: "# Top level" } });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text).join("\n");
    if (res.isError) throw new DocsPlusError(classifyToolError(text), "append_to_document", text);
  });

  // --- Final state ------------------------------------------------------------------------
  await step(`"${TARGET}" is back to its original content`, async () => {
    const end = await dp.readSection(id);
    check(JSON.stringify(end.blocks.map((b) => b.markdown)) === JSON.stringify(originalBlocks), "content differs from the start");
  });

  console.log(`\n${failures ? `${failures} FAILED` : "All write tests passed."}`);
  await client.close();
}

main().then(
  () => process.exit(failures ? 1 : 0),
  (err) => {
    console.error(`write-test aborted: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
