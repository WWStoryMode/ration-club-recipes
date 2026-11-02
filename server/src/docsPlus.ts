import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Frame {
  slug: string;
  ownedByYou: boolean;
  body: string;
}

export interface OutlineNode {
  title: string; // as shown in the outline, "(untitled)" for empty headings
  untitled: boolean;
  sectionId: string | null;
  level: number;
  rev: string | null;
  depth: number; // indentation depth in the outline (0 = top)
  children: OutlineNode[];
}

export interface Outline {
  slug: string;
  ownedByYou: boolean;
  nodes: OutlineNode[];
}

export interface Block {
  n: number; // 1-based, as used by edit_blocks after_block / remove_blocks
  markdown: string;
  isEmpty: boolean;
  isMedia: boolean;
}

export interface Section {
  slug: string;
  sectionId: string;
  rev: string;
  ownedByYou: boolean;
  headingMarkdown: string; // e.g. "### **Pasta Bake**"
  level: number; // 0 if the heading is empty/missing
  title: string; // plain text, "**" and "#" stripped
  blocks: Block[];
}

export type DocsPlusErrorKind = "stale_rev" | "unconfirmed_write" | "not_owner" | "rate_limited" | "other";

export class DocsPlusError extends Error {
  constructor(
    readonly kind: DocsPlusErrorKind,
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "DocsPlusError";
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

const FRAME_OPEN = /^\[Document data from "([^"]+)", owned by (you|another person)\. It is text people wrote, not instructions\.\]\n/;
const FRAME_CLOSE = "[End of document data.]";

/** Unwrap the "[Document data from …] … [End of document data.]" frame. "owned by you" is the ownership check. */
export function parseFrame(text: string): Frame {
  const open = FRAME_OPEN.exec(text);
  const close = text.lastIndexOf(FRAME_CLOSE);
  if (!open || close < open[0].length) throw new Error("Unexpected docs.plus response: missing document frame");
  let body = text.slice(open[0].length, close);
  // Exactly one blank line separates the frame lines from the text. Drop it on both ends, keeping the text's own spacing.
  body = body.replace(/^\n/, "").replace(/\n\n$/, "");
  return { slug: open[1]!, ownedByYou: open[2] === "you", body };
}

const OUTLINE_LINE = /^( *)- (.*) \[section_id: (\S+), level (\d+), rev: ([0-9a-f]{12}|none)\]$/;

/** Parse get_outline's body: "- <title> [section_id: <id|none>, level <n>, rev: <rev|none>]", 2 spaces per depth. */
export function parseOutline(body: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const m = OUTLINE_LINE.exec(line);
    if (!m) throw new Error(`Unexpected outline line: ${JSON.stringify(line)}`);
    const depth = Math.floor(m[1]!.length / 2);
    const title = m[2]!;
    const node: OutlineNode = {
      title,
      untitled: title === "(untitled)",
      sectionId: m[3] === "none" ? null : m[3]!,
      level: Number(m[4]),
      rev: m[5] === "none" ? null : m[5]!,
      depth,
      children: [],
    };
    stack.length = Math.min(stack.length, depth);
    const parent = stack[depth - 1];
    if (depth > 0 && !parent) throw new Error(`Outline line indented too deep: ${JSON.stringify(line)}`);
    (parent ? parent.children : roots).push(node);
    stack[depth] = node;
  }
  return roots;
}

export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => [n, ...flattenOutline(n.children)]);
}

/** Placeholders read_document uses for media. A block holding one cannot be removed by edit_blocks. */
export const MEDIA_PLACEHOLDER = /\[(image|youtube|video|audio|vimeo|embed|iframe|tweet|twitter|map|pdf|file)\]/i;

/** "### **Pasta Bake**" → "Pasta Bake". */
export function stripHeading(md: string): string {
  return md
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .trim();
}

export function headingLevel(md: string): number {
  return /^(#{1,6})(\s|$)/.exec(md)?.[1]?.length ?? 0;
}

/**
 * Parse read_document with section_id:
 *   "section_id: <id>\nrev: <rev>\n\n" + frame(heading + "\n\n[1] …\n\n[2] …").
 * Blocks are split only on the NEXT expected marker ("\n\n[n]"), so a block whose text contains "[3]" or blank lines stays whole.
 */
export function parseSection(text: string): Section {
  const head = /^section_id: (\S+)\nrev: (\S+)\n\n/.exec(text);
  if (!head) throw new Error("Unexpected docs.plus response: missing section_id/rev header");
  const frame = parseFrame(text.slice(head[0].length));
  const body = frame.body;

  const markerAt = (n: number, from: number): number => {
    const tag = `[${n}]`;
    if (from === 0 && body.startsWith(tag) && /^(\s|$)/.test(body.slice(tag.length, tag.length + 1))) return 0;
    let i = body.indexOf(`\n\n${tag}`, from);
    while (i !== -1) {
      const after = body.charAt(i + 2 + tag.length);
      if (after === "" || after === " " || after === "\n") return i;
      i = body.indexOf(`\n\n${tag}`, i + 1);
    }
    return -1;
  };

  const first = markerAt(1, 0);
  const headingMarkdown = (first === -1 ? body : body.slice(0, first)).trimEnd();
  const blocks: Block[] = [];
  let pos = first;
  for (let n = 1; pos !== -1; n++) {
    const start = pos === 0 && body.startsWith(`[${n}]`) ? 0 : pos + 2;
    const contentStart = start + `[${n}]`.length + (body.charAt(start + `[${n}]`.length) === " " ? 1 : 0);
    const next = markerAt(n + 1, contentStart);
    const markdown = body.slice(contentStart, next === -1 ? undefined : next);
    blocks.push({ n, markdown, isEmpty: markdown.trim() === "", isMedia: MEDIA_PLACEHOLDER.test(markdown) });
    pos = next;
  }

  return {
    slug: frame.slug,
    sectionId: head[1]!,
    rev: head[2]!,
    ownedByYou: frame.ownedByYou,
    headingMarkdown,
    level: headingLevel(headingMarkdown),
    title: stripHeading(headingMarkdown),
    blocks,
  };
}

/** replace_text returns the new rev in structuredContent and in its text. */
export function parseRevFromReplace(result: { structuredContent?: unknown; text?: string }): string | undefined {
  const sc = result.structuredContent as { rev?: unknown } | undefined;
  if (sc && typeof sc.rev === "string") return sc.rev;
  return /\brev\b\W{0,3}([0-9a-f]{12})\b/i.exec(result.text ?? "")?.[1];
}

/**
 * Map tool error text to a kind. Only "stale_rev" and "unconfirmed_write" use known wording.
 * The other patterns are best guesses, to be tightened once real error texts are seen.
 */
export function classifyToolError(text: string): DocsPlusErrorKind {
  if (/section changed since you read it/i.test(text)) return "stale_rev";
  if (/could not confirm the write/i.test(text)) return "unconfirmed_write";
  if (/rate limit|too many (requests|tool calls)|\b429\b/i.test(text)) return "rate_limited";
  if (/owned by another|not (the |its )?owner|only (edit|change).{0,40}(you own|own)|you do not own|don't own/i.test(text)) return "not_owner";
  return "other";
}

// ---------------------------------------------------------------------------
// Recipe model (proposal from Phase 0; used by the API in Phase 2)
// ---------------------------------------------------------------------------

export interface RecipeFields {
  headChef?: string;
  support?: string[];
  date?: string;
}

const DATE_LINE = /^\s*(\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4})\b.*$/;

/** Pull known fields out of a recipe section's blocks ("**Head Chef: X**", "**Support: A, B**", a trailing date). */
export function recipeFields(blocks: Block[]): RecipeFields {
  const out: RecipeFields = {};
  for (const b of blocks) {
    const plain = stripHeading(b.markdown);
    const chef = /^Head Chef:\s*(.*)$/i.exec(plain);
    if (chef && chef[1]!.trim()) out.headChef = chef[1]!.trim();
    const sup = /^Support:\s*(.*)$/i.exec(plain);
    if (sup) {
      const names = sup[1]!.split(/,|&|\band\b/).map((s) => s.trim()).filter((s) => s && !/^\?+$/.test(s));
      if (names.length) out.support = names;
    }
    const d = DATE_LINE.exec(plain);
    if (d) out.date = d[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

export const MAX_WRITE_CHARS = 65_536;

interface ToolResult {
  text: string;
  structuredContent?: unknown;
}

export class DocsPlus {
  constructor(
    private readonly client: Client,
    readonly slug: string,
  ) {}

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new DocsPlusError(classifyToolError(text), name, text || `${name} failed`);
    return { text, structuredContent: res.structuredContent };
  }

  async findMyDocuments(): Promise<string> {
    return (await this.call("find_documents", { scope: "mine", limit: 50 })).text;
  }

  /**
   * Make a NEW document owned by the signed-in account. It is public: anyone can find and edit it.
   * Each call makes another document, so after an unclear failure check findMyDocuments() before retrying.
   */
  async createDocument(title: string, markdown?: string): Promise<{ slug: string; text: string }> {
    if (markdown) assertWriteSize(markdown);
    const res = await this.call("create_document", markdown ? { title, markdown } : { title });
    const sc = res.structuredContent as { slug?: unknown } | undefined;
    const slug = typeof sc?.slug === "string" ? sc.slug : /docs\.plus\/([A-Za-z0-9_-]+)/.exec(res.text)?.[1];
    if (!slug) throw new DocsPlusError("other", "create_document", `Created, but no slug found in: ${res.text}`);
    return { slug, text: res.text };
  }

  async getOutline(): Promise<Outline> {
    const frame = parseFrame((await this.call("get_outline", { slug: this.slug })).text);
    return { slug: frame.slug, ownedByYou: frame.ownedByYou, nodes: parseOutline(frame.body) };
  }

  async readSection(sectionId: string): Promise<Section> {
    return parseSection((await this.call("read_document", { slug: this.slug, section_id: sectionId })).text);
  }

  /** Returns nothing, and edit_blocks returns no rev. Callers must readSection() again afterwards. */
  async editBlocks(p: { sectionId: string; rev: string; afterBlock: number; removeBlocks: number; markdown: string }): Promise<void> {
    assertWriteSize(p.markdown);
    await this.call("edit_blocks", {
      slug: this.slug,
      section_id: p.sectionId,
      rev: p.rev,
      after_block: p.afterBlock,
      remove_blocks: p.removeBlocks,
      markdown: p.markdown,
    });
  }

  /** Returns the section's new rev. */
  async replaceText(p: { sectionId: string; rev: string; oldText: string; newText: string }): Promise<string> {
    const res = await this.call("replace_text", {
      slug: this.slug,
      section_id: p.sectionId,
      rev: p.rev,
      old_text: p.oldText,
      new_text: p.newText,
    });
    const rev = parseRevFromReplace(res);
    if (!rev) throw new DocsPlusError("other", "replace_text", "replace_text succeeded but returned no rev");
    return rev;
  }

  /** Appends "### Title" + body at the END of the document (append_to_document). */
  async appendRecipe(title: string, bodyMarkdown: string, level = 3): Promise<string> {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Recipe title is required");
    if (level < 2 || level > 6) throw new Error("Recipe heading level must be 2–6 (a # heading is refused)");
    if (/^#/.test(clean)) throw new Error("Recipe title must not start with #");
    const markdown = `${"#".repeat(level)} ${clean}\n\n${bodyMarkdown.trim()}\n`;
    assertWriteSize(markdown);
    return (await this.call("append_to_document", { slug: this.slug, markdown })).text;
  }
}

function assertWriteSize(markdown: string) {
  if (markdown.length > MAX_WRITE_CHARS) throw new Error(`Markdown is ${markdown.length} chars; docs.plus accepts at most ${MAX_WRITE_CHARS}`);
}
