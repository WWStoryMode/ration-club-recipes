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
import { formatCaption, formatRecipe, parseCaption, parseRecipe, type RecipeForm } from "./recipeForm.js";
import { checkImageLink, photoMarkdown, PHOTO_LIMITS, type PhotoLinkStore } from "./photos.js";
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

export interface NewPhoto {
  url: string;
  caption: string;
}

/**
 * Form values a visitor may send. Not `other` (always from the document) and not the photos themselves: only a
 * caption for each existing photo, in order, plus links for new photos.
 */
export type VisitorForm = Omit<RecipeForm, "other" | "photos"> & { photos?: Array<{ caption: string }>; newPhotos?: NewPhoto[] };

/** New photos ready to add at the end of a recipe: the Markdown, and the checked links (for our record). */
export interface PhotoAppend {
  markdown: string;
  photos: NewPhoto[];
}

export const FORM_REASONS = {
  subsections: "This recipe has its own sub-headings, so only the organisers can edit it.",
  captions: "This recipe has longer text under its pictures, so only the organisers can edit it.",
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
  /** Our record of photo links per recipe (docs.plus reads pictures back only as "[image]"). */
  photoLinks?: PhotoLinkStore;
  /** Checks a photo link really is a public image. Default: fetches it (checkImageLink). */
  checkLink?: (url: string) => Promise<string>;
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
    const read = await this.formOf(sections[0]!);
    const reason = summary.subsections.length ? FORM_REASONS.subsections : read.reason;
    return {
      ...summary,
      fields: recipeFields(sections[0]!.blocks),
      sections: views,
      form: { editable: !reason, ...(reason ? { reason } : {}), rev: sections[0]!.rev, values: read.values },
    };
  }

  /**
   * A recipe section as form values. The text before the first picture fills the fields; each picture or video
   * after that has its caption (the text up to the next one). Links come from our record: we only ever add photos
   * at the end, so our links belong to the last pictures. A photo added by hand in docs.plus shows without a link.
   */
  private async formOf(s: Section): Promise<{ values: RecipeForm; reason?: string }> {
    const segs = toSegments(s.blocks);
    const values = parseRecipe(segs[0]!.blocks);
    const links = (await this.o.photoLinks?.get(s.sectionId)) ?? [];
    const media = segs.filter((g) => g.kind === "media");
    const images = media.filter((g) => mediaKind(g.blocks[0]!.markdown) === "image");
    let reason: string | undefined;
    values.photos = media.map((g, i) => {
      const caption = parseCaption(segs[2 * i + 2]!.blocks);
      if (caption === undefined) reason = FORM_REASONS.captions;
      const kind = mediaKind(g.blocks[0]!.markdown);
      const j = images.indexOf(g) - (images.length - links.length);
      return { kind, caption: caption ?? "", ...(kind === "image" && j >= 0 && links[j] ? { url: links[j] } : {}) };
    });
    return { values, reason };
  }

  /**
   * The text to save for a visitor's form. Reads the recipe as it is now: the baseRev must still match (409 with the
   * latest version if not), the layout must fit the form, and text that fits no field is carried over from the
   * document, never taken from the visitor.
   */
  async formSave(recipeId: string, baseRev: string, form: VisitorForm): Promise<{ parts: string[]; append?: PhotoAppend }> {
    const outline = await this.outline();
    const recipe = this.recipeOf(outline, recipeId);
    if (recipe.sectionId !== recipeId) throw new ApiError("not_found", "That's a part of a recipe, not a recipe. Please reload.");
    if (flattenOutline(recipe.children).length) throw new ApiError("invalid", FORM_REASONS.subsections);
    const s = await this.o.docs.readSection(recipeId);
    if (s.rev !== baseRev) throw new ApiError("conflict", MESSAGES.conflict, { latest: await this.getRecipeFresh(recipeId) });
    const { values, reason } = await this.formOf(s);
    if (reason) throw new ApiError("invalid", reason);
    const captions = form.photos ?? [];
    if (captions.length !== values.photos.length) throw new ApiError("invalid", "The photos in this recipe have changed. Please reload and try again.");
    const parts = [formatRecipe({ ...form, other: values.other }), ...captions.map((p) => formatCaption(p.caption))];
    return { parts, append: await this.photoAppend(form.newPhotos ?? [], values.photos.length) };
  }

  /**
   * Check new photo links and build their Markdown. At most 3 per save and 6 per recipe, since the app can never
   * remove a picture again. Each link is fetched once to make sure it is a public image.
   */
  async photoAppend(photos: NewPhoto[], existing: number): Promise<PhotoAppend | undefined> {
    const wanted = photos.filter((p) => p.url.trim());
    if (!wanted.length) return undefined;
    if (wanted.length > PHOTO_LIMITS.perSave) throw new ApiError("invalid", `Please add at most ${PHOTO_LIMITS.perSave} photos at a time.`);
    if (existing + wanted.length > PHOTO_LIMITS.perRecipe) {
      throw new ApiError("invalid", `A recipe can have at most ${PHOTO_LIMITS.perRecipe} photos${existing ? ` (it has ${existing} already)` : ""}.`);
    }
    const check = this.o.checkLink ?? ((u: string) => checkImageLink(u));
    const checked: NewPhoto[] = [];
    for (const [i, p] of wanted.entries()) {
      try {
        formatCaption(p.caption); // refuse a bad caption before fetching anything
        checked.push({ url: await check(p.url), caption: p.caption.replace(/\s+/g, " ").trim() });
      } catch (err) {
        if (err instanceof ApiError && wanted.length > 1) throw new ApiError(err.code, `Photo ${i + 1}: ${err.message}`, err.extra);
        throw err;
      }
    }
    const markdown = checked.map((p) => photoMarkdown(p.url, formatCaption(p.caption), p.caption)).join("\n\n");
    return { markdown, photos: checked };
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
  async saveSection(sectionId: string, baseRev: string | null, texts: string[], append?: PhotoAppend): Promise<SaveResult> {
    const clean = this.cleanTexts(texts);
    const recipe = this.recipeIdent(await this.outline(), sectionId); // must be a recipe or one of its subsections

    return this.o.lock.withLock(this.o.slug, async () => {
      try {
        try {
          return { ...(await this.writeSection(sectionId, baseRev, clean, append)), recipe };
        } catch (err) {
          // Someone wrote between our read and our edit. Retry once; writeSection re-reads and re-checks baseRev.
          if (err instanceof DocsPlusError && err.kind === "stale_rev") return { ...(await this.writeSection(sectionId, baseRev, clean, append)), recipe };
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

  private async writeSection(sectionId: string, baseRev: string | null, texts: string[], append?: PhotoAppend): Promise<Omit<SaveResult, "recipe">> {
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
    if (append) {
      // New photos go at the very end, after every caption. Never retried here: a retry could add them twice.
      await this.o.docs.editBlocks({ sectionId, rev: s.rev, afterBlock: s.blocks.length, removeBlocks: 0, markdown: append.markdown });
      await this.o.photoLinks?.add(sectionId, append.photos.map((p) => p.url));
      s = await this.o.docs.readSection(sectionId);
    }
    return { section: sectionView(s), before, changed: changed.length > 0 || !!append };
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
  async addRecipe(rawTitle: string, rawMarkdown: string, append?: PhotoAppend): Promise<RecipeSummary> {
    const title = checkTitle(rawTitle);
    const text = checkVisitorMarkdown(rawMarkdown) || "**Head Chef: ???**\n\n**Support: ???**\n\n**Ingredients**\n\n**Method**";
    const body = append ? `${text}\n\n${append.markdown}` : text; // photos are built by us, after the visitor-text check

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
        if (append) await this.o.photoLinks?.add(added.sectionId, append.photos.map((p) => p.url));
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
