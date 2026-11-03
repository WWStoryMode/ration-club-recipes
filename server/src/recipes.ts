import {
  DocsPlusError,
  flattenOutline,
  MEDIA_PLACEHOLDER,
  recipeFields,
  type Block,
  type DocsPlus,
  type Outline,
  type OutlineNode,
  type RecipeFields,
  type Section,
} from "./docsPlus.js";
import { ApiError, MESSAGES } from "./errors.js";
import type { Lock } from "./lock.js";
import { formatRecipe, parseRecipe, type RecipeForm } from "./recipeForm.js";
import { checkTitle, checkVisitorMarkdown, LIMITS, normalizeMarkdown } from "./validate.js";

/** The parts of the docs.plus wrapper the service uses, so tests can swap in a fake. */
export type DocsPort = Pick<DocsPlus, "getOutline" | "readSection" | "editBlocks" | "appendRecipe">;

// ---------------------------------------------------------------------------
// Views returned by the API
// ---------------------------------------------------------------------------

export interface RecipeSummary {
  id: string;
  title: string;
  subsections: Array<{ id: string; title: string; level: number }>;
}

/** A section's body, split around media. Text parts are editable; media parts are fixed. */
export type Part = { type: "text"; markdown: string } | { type: "media"; kind: string };

export interface SectionView {
  id: string;
  title: string;
  level: number;
  rev: string;
  hasMedia: boolean;
  parts: Part[];
}

/** What a save did: the section before and after, and whether anything was written. For the audit log. */
export interface SaveResult {
  section: SectionView;
  before: SectionView;
  changed: boolean;
  recipe: { id: string; title: string };
}

export interface RecipeView extends RecipeSummary {
  fields: RecipeFields;
  sections: SectionView[]; // the recipe's own section first, then its subsections in order
  /** The recipe as form values. `editable: false` (with a reason) when its layout doesn't fit the form. */
  form: { editable: boolean; reason?: string; rev: string; values: RecipeForm };
}

/** Form values a visitor may send: everything except `other`, which always comes from the document. */
export type VisitorForm = Omit<RecipeForm, "other">;

export const FORM_REASONS = {
  subsections: "This recipe has its own sub-headings, so only the organisers can edit it.",
  media: "This recipe has pictures or videos, so only the organisers can edit it.",
};

// ---------------------------------------------------------------------------
// Segments: runs of text blocks between media blocks
// ---------------------------------------------------------------------------

interface Segment {
  kind: "text" | "media";
  start: number; // number of blocks before this segment (= after_block for edit_blocks)
  count: number;
  blocks: Block[];
}

/** Always text, media, text, media, …, text. Text segments may be empty, so a body with k media has k+1 text parts. */
export function toSegments(blocks: Block[]): Segment[] {
  const segs: Segment[] = [{ kind: "text", start: 0, count: 0, blocks: [] }];
  for (const b of blocks) {
    if (b.isMedia) {
      segs.push({ kind: "media", start: b.n - 1, count: 1, blocks: [b] });
      segs.push({ kind: "text", start: b.n, count: 0, blocks: [] });
    } else {
      const last = segs.at(-1)!;
      last.count++;
      last.blocks.push(b);
    }
  }
  return segs;
}

const segmentText = (s: Segment) => s.blocks.filter((b) => !b.isEmpty).map((b) => b.markdown).join("\n\n");
const mediaKind = (md: string) => MEDIA_PLACEHOLDER.exec(md)?.[1]?.toLowerCase() ?? "media";

export function sectionView(s: Section): SectionView {
  const parts: Part[] = toSegments(s.blocks).map((seg) =>
    seg.kind === "media" ? { type: "media", kind: mediaKind(seg.blocks[0]!.markdown) } : { type: "text", markdown: segmentText(seg) },
  );
  return { id: s.sectionId, title: s.title, level: s.level, rev: s.rev, hasMedia: parts.some((p) => p.type === "media"), parts };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RecipesOptions {
  docs: DocsPort;
  lock: Lock;
  slug: string;
  /** Read cache lifetime. docs.plus allows 60 tool calls/min for the whole app, so reads are cached briefly. */
  cacheMs?: number;
  now?: () => number;
}

export class RecipesService {
  private cache = new Map<string, { at: number; value: unknown }>();
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly o: RecipesOptions) {
    this.cacheMs = o.cacheMs ?? 10_000;
    this.now = o.now ?? Date.now;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  invalidate() {
    this.cache.clear();
  }

  private outline(fresh = false): Promise<Outline> {
    return fresh ? this.o.docs.getOutline() : this.cached("outline", () => this.o.docs.getOutline());
  }

  /** The booklet is the first top-level heading; its direct children are the recipes. */
  private root(outline: Outline): OutlineNode {
    const root = outline.nodes[0];
    if (!root) throw new ApiError("unavailable", MESSAGES.unavailable);
    return root;
  }

  private summary(node: OutlineNode): RecipeSummary {
    return {
      id: node.sectionId!,
      title: node.title,
      subsections: flattenOutline(node.children)
        .filter((n) => n.sectionId)
        .map((n) => ({ id: n.sectionId!, title: n.title, level: n.level })),
    };
  }

  /** The recipe containing sectionId (the recipe itself or one of its subsections), or 404. */
  private recipeOf(outline: Outline, sectionId: string): OutlineNode {
    for (const recipe of this.root(outline).children) {
      if (recipe.sectionId === sectionId || flattenOutline(recipe.children).some((n) => n.sectionId === sectionId)) return recipe;
    }
    throw new ApiError("not_found", "That recipe or section doesn't exist. It may have been removed. Please reload.");
  }

  async listRecipes(): Promise<RecipeSummary[]> {
    return this.root(await this.outline()).children.filter((n) => n.sectionId).map((n) => this.summary(n));
  }

  async getRecipe(id: string): Promise<RecipeView> {
    const outline = await this.outline();
    const recipe = this.recipeOf(outline, id);
    if (recipe.sectionId !== id) throw new ApiError("not_found", "That's a part of a recipe, not a recipe. Please reload.");
    const ids = [id, ...this.summary(recipe).subsections.map((s) => s.id)];
    const sections = await Promise.all(ids.map((sid) => this.cached(`section:${sid}`, () => this.o.docs.readSection(sid))));
    const summary = this.summary(recipe);
    const views = sections.map(sectionView);
    const reason = summary.subsections.length ? FORM_REASONS.subsections : views[0]!.hasMedia ? FORM_REASONS.media : undefined;
    return {
      ...summary,
      fields: recipeFields(sections[0]!.blocks),
      sections: views,
      form: { editable: !reason, ...(reason ? { reason } : {}), rev: sections[0]!.rev, values: parseRecipe(sections[0]!.blocks) },
    };
  }

  /**
   * The text to save for a visitor's form. Reads the recipe as it is now: the baseRev must still match (409 with the
   * latest version if not), the layout must fit the form, and text that fits no field is carried over from the
   * document, never taken from the visitor.
   */
  async formTexts(recipeId: string, baseRev: string, form: VisitorForm): Promise<string[]> {
    const outline = await this.outline();
    const recipe = this.recipeOf(outline, recipeId);
    if (recipe.sectionId !== recipeId) throw new ApiError("not_found", "That's a part of a recipe, not a recipe. Please reload.");
    if (flattenOutline(recipe.children).length) throw new ApiError("invalid", FORM_REASONS.subsections);
    const s = await this.o.docs.readSection(recipeId);
    if (s.rev !== baseRev) throw new ApiError("conflict", MESSAGES.conflict, { latest: await this.getRecipeFresh(recipeId) });
    if (s.blocks.some((b) => b.isMedia)) throw new ApiError("invalid", FORM_REASONS.media);
    return [formatRecipe({ ...form, other: parseRecipe(s.blocks).other })];
  }

  private async getRecipeFresh(id: string): Promise<RecipeView> {
    this.invalidate();
    return this.getRecipe(id);
  }

  /** The body for a new recipe from form values. */
  formBody(form: VisitorForm): string {
    return formatRecipe({ ...form, other: "" });
  }

  /** A section as it is now (uncached), for an organiser reviewing a pending change. */
  async currentSection(sectionId: string): Promise<SectionView> {
    this.recipeOf(await this.outline(), sectionId);
    return sectionView(await this.o.docs.readSection(sectionId));
  }

  /** The id of the booklet heading (the first top-level section), whose chat room is the general one. */
  async bookletId(): Promise<string | undefined> {
    return this.root(await this.outline()).sectionId ?? undefined;
  }

  /**
   * Everything saveSection checks, without writing: clean text, the section is part of a recipe, the visitor's
   * baseRev is still current (409 with the latest version if not), and the number of text parts matches.
   * Used to queue a change for approval, so visitors hear about problems straight away.
   */
  async checkSection(sectionId: string, baseRev: string, texts: string[]): Promise<{ texts: string[]; recipe: { id: string; title: string }; before: SectionView; changed: boolean }> {
    const clean = this.cleanTexts(texts);
    const recipe = this.recipeIdent(await this.outline(), sectionId);
    const s = await this.o.docs.readSection(sectionId);
    if (s.rev !== baseRev) throw new ApiError("conflict", MESSAGES.conflict, { latest: sectionView(s) });
    const textSegs = this.textSegments(s, clean);
    return { texts: clean, recipe, before: sectionView(s), changed: textSegs.some((g, i) => normalizeMarkdown(segmentText(g)) !== clean[i]) };
  }

  /**
   * Replace a section's text parts. `baseRev` is the rev the visitor started from: if the section changed
   * since then, nothing is written and the latest version comes back with a 409.
   * `baseRev: null` writes over whatever is there now (an organiser approving a change that has since been overtaken).
   * Media blocks are never touched. Changed text parts are written bottom-up, so earlier block numbers stay valid.
   */
  async saveSection(sectionId: string, baseRev: string | null, texts: string[]): Promise<SaveResult> {
    const clean = this.cleanTexts(texts);
    const recipe = this.recipeIdent(await this.outline(), sectionId); // must be a recipe or one of its subsections

    return this.o.lock.withLock(this.o.slug, async () => {
      try {
        try {
          return { ...(await this.writeSection(sectionId, baseRev, clean)), recipe };
        } catch (err) {
          // Someone wrote between our read and our edit. Retry once; writeSection re-reads and re-checks baseRev.
          if (err instanceof DocsPlusError && err.kind === "stale_rev") return { ...(await this.writeSection(sectionId, baseRev, clean)), recipe };
          throw err;
        }
      } finally {
        this.invalidate();
      }
    });
  }

  private cleanTexts(texts: string[]): string[] {
    if (texts.length > LIMITS.texts) throw new ApiError("invalid", "Too many parts in one save.");
    return texts.map((t, i) => checkVisitorMarkdown(t, texts.length > 1 ? `Part ${i + 1}` : "Text"));
  }

  private recipeIdent(outline: Outline, sectionId: string) {
    const node = this.recipeOf(outline, sectionId);
    return { id: node.sectionId!, title: node.title };
  }

  private textSegments(s: Section, texts: string[]) {
    const textSegs = toSegments(s.blocks).filter((g) => g.kind === "text");
    if (texts.length !== textSegs.length) {
      throw new ApiError("invalid", `This section has ${textSegs.length} text part(s), but ${texts.length} were sent. Please reload.`);
    }
    return textSegs;
  }

  private async writeSection(sectionId: string, baseRev: string | null, texts: string[]): Promise<Omit<SaveResult, "recipe">> {
    let s = await this.o.docs.readSection(sectionId);
    if (baseRev !== null && s.rev !== baseRev) throw new ApiError("conflict", MESSAGES.conflict, { latest: sectionView(s) });
    const before = sectionView(s);

    const textSegs = this.textSegments(s, texts);
    const changed = textSegs.map((g, i) => i).filter((i) => normalizeMarkdown(segmentText(textSegs[i]!)) !== texts[i]);

    for (let k = changed.length - 1; k >= 0; k--) {
      const seg = textSegs[changed[k]!]!;
      await this.o.docs.editBlocks({ sectionId, rev: s.rev, afterBlock: seg.start, removeBlocks: seg.count, markdown: texts[changed[k]!]! });
      s = await this.o.docs.readSection(sectionId); // edit_blocks returns no rev
    }
    return { section: sectionView(s), before, changed: changed.length > 0 };
  }

  /** Everything addRecipe checks, without writing: a valid name and body, and no recipe with that name yet. */
  async checkNewRecipe(rawTitle: string, rawMarkdown: string): Promise<{ title: string; markdown: string }> {
    const title = checkTitle(rawTitle);
    const markdown = checkVisitorMarkdown(rawMarkdown);
    this.assertNewName(this.root(await this.outline()), title);
    return { title, markdown };
  }

  private assertNewName(root: OutlineNode, title: string) {
    if (root.children.some((c) => nameKey(c.title) === nameKey(title))) {
      throw new ApiError("conflict", `There's already a recipe called "${title}". Please edit that one, or choose another name.`);
    }
  }

  /**
   * Add a recipe at the end of the booklet, in its current format: "### **Title**" + body.
   * Refuses if anything other than the booklet comes last (the recipe would land under the wrong heading),
   * or if a recipe with the same name exists.
   */
  async addRecipe(rawTitle: string, rawMarkdown: string): Promise<RecipeSummary> {
    const title = checkTitle(rawTitle);
    const body = checkVisitorMarkdown(rawMarkdown) || "**Head Chef: ???**\n\n**Support: ???**\n\n**Ingredients**\n\n**Method**";

    return this.o.lock.withLock(this.o.slug, async () => {
      try {
        const outline = await this.outline(true);
        const root = this.root(outline);
        if (outline.nodes.at(-1) !== root) {
          console.error("[recipes] the booklet heading is not the last top-level section; refusing to append");
          throw new ApiError("unavailable", MESSAGES.unavailable);
        }
        this.assertNewName(root, title);
        const level = mostCommonLevel(root.children) ?? 3;
        await this.o.docs.appendRecipe(`**${title}**`, body, level); // never retried: a retry could add it twice

        const added = this.root(await this.outline(true)).children.filter((c) => nameKey(c.title) === nameKey(title)).at(-1);
        if (!added?.sectionId) throw new ApiError("unconfirmed", MESSAGES.unconfirmed);
        return this.summary(added);
      } finally {
        this.invalidate();
      }
    });
  }
}

const nameKey = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

function mostCommonLevel(nodes: OutlineNode[]): number | undefined {
  const counts = new Map<number, number>();
  for (const n of nodes) counts.set(n.level, (counts.get(n.level) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
