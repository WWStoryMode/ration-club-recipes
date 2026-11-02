/**
 * pnpm create-test-doc [--new]: create the fictional TEST document (owned by the signed-in account)
 * and point DOC_SLUG in .env at it. If a doc with the test title already exists, it reuses that one
 * (create_document always makes a new doc, so this avoids duplicates). --new forces another.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { DocsPlus } from "../docsPlus.js";
import { connect, defaultStore, makeProvider } from "../mcp.js";
import { TEST_DOC_TITLE, testDocMarkdown } from "../seed/testRecipes.js";

/** Slugs of documents in a find_documents listing whose title is exactly `title`. Lines look like
 *  "- <slug>: <title> (yours, updated <iso>)", and titles may contain parentheses themselves. */
export function findTitled(listing: string, title: string): string[] {
  return listing
    .split("\n")
    .map((l) => /^- ([A-Za-z0-9_-]+): (.*) \((?:yours|another person’s|another person's)(?:, [^)]*)?\)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2] === title)
    .map((m) => m[1]!);
}

async function setEnvSlug(slug: string) {
  const file = path.join(config.repoRoot, ".env");
  let text = await readFile(file, "utf8").catch(() => "");
  text = /^DOC_SLUG=.*$/m.test(text) ? text.replace(/^DOC_SLUG=.*$/m, `DOC_SLUG=${slug}`) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}DOC_SLUG=${slug}\n`;
  await writeFile(file, text);
  console.log(`.env: DOC_SLUG=${slug}`);
}

async function main() {
  const { client } = await connect(makeProvider(defaultStore()));
  const dp = new DocsPlus(client, "");

  const mine = await dp.findMyDocuments();
  const matches = findTitled(mine, TEST_DOC_TITLE);
  if (matches.length > 1) console.warn(`Note: ${matches.length} test docs exist: ${matches.join(", ")}. Using the first.`);
  const existing = matches[0];

  if (existing && !process.argv.includes("--new")) {
    console.log(`Test doc already exists: https://docs.plus/${existing}  (use --new to make another)`);
    await setEnvSlug(existing);
  } else {
    const { slug, text } = await dp.createDocument(TEST_DOC_TITLE, testDocMarkdown());
    console.log(text);
    console.log(`\nCreated test doc: https://docs.plus/${slug}  (public: anyone can find and edit it)`);
    await setEnvSlug(slug);
  }
  await client.close();
}

if (process.argv[1]?.endsWith("createTestDoc.ts")) main().then(
  () => process.exit(0),
  (err) => {
    console.error(`create-test-doc failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
