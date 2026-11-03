import { createHash } from "node:crypto";
import { DocsPlusError, headingLevel, MEDIA_PLACEHOLDER, stripHeading, type Outline, type OutlineNode, type Section } from "../src/docsPlus.js";
import type { DocsPort } from "../src/recipes.js";

interface FakeSection {
  id: string;
  heading: string; // e.g. "### **Pasta Bake**"
  blocks: string[];
}

/**
 * In-memory docs.plus that copies the behaviour measured by write-test / format-test:
 * content-hash revs, stale-rev refusal, media blocks can't be removed, edit_blocks can't add headings
 * (visitor input never contains them), append adds at the end, and edit_blocks/append return no rev.
 */
export class FakeDocs implements DocsPort {
  sections: FakeSection[];
  calls: string[] = [];
  /** Hooks for simulating other editors or failures. */
  beforeEdit?: (call: number) => void;
  failAppend?: DocsPlusError;
  private nextId = 1;
  private edits = 0;

  constructor(sections: Array<{ heading: string; blocks?: string[] }>) {
    this.sections = sections.map((s) => ({ id: this.newId(), heading: s.heading, blocks: s.blocks ?? [] }));
  }

  private newId() {
    return `sec${String(this.nextId++).padStart(3, "0")}`;
  }

  static rev(s: FakeSection) {
    return createHash("sha256").update(`${s.heading}\u0000${s.blocks.join("\u0000")}`).digest("hex").slice(0, 12);
  }

  byTitle(title: string) {
    const s = this.sections.find((x) => stripHeading(x.heading) === title);
    if (!s) throw new Error(`no section ${title}`);
    return s;
  }

  async getOutline(): Promise<Outline> {
    this.calls.push("getOutline");
    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    for (const s of this.sections) {
      const level = headingLevel(s.heading);
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const title = stripHeading(s.heading);
      const node: OutlineNode = { title: title || "(untitled)", untitled: !title, sectionId: s.id, level, rev: FakeDocs.rev(s), depth: stack.length, children: [] };
      (stack.at(-1)?.children ?? roots).push(node);
      stack.push(node);
    }
    return { slug: "fake", ownedByYou: true, nodes: roots };
  }

  async readSection(id: string): Promise<Section> {
    this.calls.push(`read:${id}`);
    const s = this.find(id);
    return {
      slug: "fake",
      sectionId: s.id,
      rev: FakeDocs.rev(s),
      ownedByYou: true,
      headingMarkdown: s.heading,
      level: headingLevel(s.heading),
      title: stripHeading(s.heading),
      blocks: s.blocks.map((m, i) => ({ n: i + 1, markdown: m, isEmpty: m.trim() === "", isMedia: MEDIA_PLACEHOLDER.test(m) })),
    };
  }

  async editBlocks(p: { sectionId: string; rev: string; afterBlock: number; removeBlocks: number; markdown: string }) {
    this.beforeEdit?.(this.edits++);
    this.calls.push(`edit:${p.sectionId}:${p.afterBlock}:${p.removeBlocks}`);
    const s = this.find(p.sectionId);
    if (FakeDocs.rev(s) !== p.rev) {
      throw new DocsPlusError("stale_rev", "edit_blocks", "The section changed since you read it. Call read_document or get_outline again, then retry with the new rev.");
    }
    const removed = s.blocks.slice(p.afterBlock, p.afterBlock + p.removeBlocks);
    if (removed.some((m) => MEDIA_PLACEHOLDER.test(m))) {
      throw new DocsPlusError("invalid_input", "edit_blocks", `remove_blocks: block(s) ${p.afterBlock + 1} hold a picture, video or file, and docs.plus never deletes media for an AI app.`);
    }
    if (/^#{1,6}\s/m.test(p.markdown)) throw new DocsPlusError("invalid_input", "edit_blocks", "markdown: fake does not support headings");
    s.blocks.splice(p.afterBlock, p.removeBlocks, ...toBlocks(p.markdown));
  }

  async appendRecipe(title: string, body: string, level = 3) {
    this.calls.push(`append:${title}`);
    if (this.failAppend) throw this.failAppend;
    this.sections.push({ id: this.newId(), heading: `${"#".repeat(level)} ${title}`, blocks: toBlocks(body) });
    return "Appended.";
  }

  private find(id: string) {
    const s = this.sections.find((x) => x.id === id);
    if (!s) throw new DocsPlusError("other", "read_document", "No section with that section_id.");
    return s;
  }
}

/** Paragraphs → blocks. Like docs.plus, a picture (`![alt](url)`) becomes a media block that reads back as "\[image\]". */
const toBlocks = (md: string) => (md ? md.split(/\n{2,}/).map((b) => (/^!\[[^\]]*\]\([^)]*\)$/.test(b.trim()) ? "\\[image\\]" : b)) : []);

/** A small booklet shaped like the real one, with one recipe holding subsections and media. */
export function booklet() {
  return new FakeDocs([
    { heading: "# Ration Club: A Community Recipe Booklet", blocks: ["Intro paragraph."] },
    { heading: "### **Pasta Bake**", blocks: ["**Head Chef: Chef Alpha**", "**Support: Helper One, Helper Two**", "", "", "30 September 2026"] },
    { heading: "### **Format Recipe**", blocks: ["**Head Chef: Chef Echo**", "3 February 2027", "\\[image\\]", "Caption under the image"] },
    { heading: "#### Ingredients", blocks: ["- 1 kg rice\n- 2 onions"] },
    { heading: "#### Method", blocks: ["1. Fry.\n2. Add rice.", "\\[youtube\\]"] },
  ]);
}
