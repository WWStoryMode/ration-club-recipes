/** pnpm check: connect, list tools, list my documents, and check ownership of DOC_SLUG. Read-only. */
import { config } from "../config.js";
import { DocsPlus, type OutlineNode } from "../docsPlus.js";
import { connect, defaultStore, makeProvider } from "../mcp.js";

function printTree(nodes: OutlineNode[]) {
  for (const n of nodes) {
    console.log(`${"  ".repeat(n.depth)}- ${n.title}  (h${n.level}, ${n.sectionId ?? "no id"}, rev ${n.rev ?? "none"})`);
    printTree(n.children);
  }
}

async function main() {
  const { client } = await connect(makeProvider(defaultStore()));
  const dp = new DocsPlus(client, config.docSlug);

  const { tools } = await client.listTools();
  console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

  const mine = await dp.findMyDocuments();
  console.log(`MY DOCUMENTS:\n${mine}\n`);
  console.log(`${config.docSlug} listed as mine: ${mine.includes(config.docSlug) ? "yes" : "no"}\n`);

  const outline = await dp.getOutline();
  console.log(`OWNER: ${outline.ownedByYou ? "yes" : "no"}\n`);
  console.log(`OUTLINE of ${outline.slug}:`);
  printTree(outline.nodes);
  await client.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`check failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
