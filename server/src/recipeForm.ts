import type { Block } from "./docsPlus.js";
import { ApiError } from "./errors.js";

/**
 * Visitors edit recipes through a form, never Markdown. This file turns a recipe section into form fields and back,
 * in the booklet's layout:
 *
 *   **Head Chef: Mario**
 *   **Support: William, Noam**
 *   **Serves: 30**                 (optional)
 *   **Cost: about £25**            (optional)
 *   **Ingredients**
 *   - 1 kg pasta
 *   **Method**
 *   1. Boil the pasta.
 *   **Tips & substitutions**       (optional)
 *   - Use any short pasta.
 *   **Story**                      (optional)
 *   A paragraph or two.
 *   (other text already in the recipe, kept as it was)
 *   30 September 2026
 *
 * Every value is plain text: Markdown characters are escaped on the way in and unescaped on the way out.
 */

export interface RecipeForm {
  headChef: string;
  helpers: string; // comma-separated names
  date: string; // YYYY-MM-DD or ""
  serves: string;
  cost: string;
  ingredients: string[];
  method: string[];
  tips: string[];
  story: string;
  /** Text already in the recipe that fits no field. Shown read-only and written back unchanged. Never from visitors. */
  other: string;
  /** Pictures and videos at the end of the recipe, in order, each with the caption line under it. */
  photos: PhotoValue[];
}

export interface PhotoValue {
  kind: string; // "image", "youtube", …
  caption: string;
  /** The link, when we added it (docs.plus reads pictures back only as "[image]"). Display only. */
  url?: string;
}

export const FORM_LIMITS = { name: 200, short: 100, line: 500, lines: 100, story: 5000, caption: 200 };

export const emptyForm = (): RecipeForm => ({ headChef: "", helpers: "", date: "", serves: "", cost: "", ingredients: [], method: [], tips: [], story: "", other: "", photos: [] });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE = new RegExp(`^(\\d{1,2}) (${MONTHS.join("|")}) (\\d{4})$`);

/** "2026-09-30" → "30 September 2026" (the booklet's style). */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return "";
  return `${day} ${month} ${m[1]}`;
}

/** "30 September 2026" → "2026-09-30", or "" if it isn't a date in the booklet's style. */
export function parseDate(text: string): string {
  const m = DATE.exec(text.trim());
  if (!m) return "";
  return `${m[3]}-${String(MONTHS.indexOf(m[2]!) + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Plain text ↔ Markdown
// ---------------------------------------------------------------------------

const SPECIAL = /[\\`*_[\]<>#|~]/g;

/** Make visitor text literal: no bold, links, HTML or headings, and no line that starts a list or quote. */
export function escapeText(text: string): string {
  return text
    .replace(SPECIAL, (c) => `\\${c}`)
    .replace(/\]\(/g, "]\\(") // "](" could still read as a link
    .split("\n")
    .map((line) => line.replace(/^(\s*)([-+>]|\d+[.)])(\s)/, (_m, sp, mark, s) => `${sp}${mark.replace(/^([-+>])$/, "\\$1").replace(/^(\d+)([.)])$/, "$1\\$2")}${s}`))
    .join("\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** docs.plus reads &, < and > back as HTML entities. Decoded in one pass, so a typed "&amp;" survives. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** Remove Markdown escapes and entities, giving the text people see. */
export function unescapeText(md: string): string {
  return decodeEntities(md.replace(/\\([\\`*_[\]<>#|~\-+.)!(){}])/g, "$1"));
}

/**
 * The text people see, from a line docs.plus gave back: bold markers that aren't escaped are dropped (someone may
 * have bolded words in docs.plus), and links (docs.plus turns typed web addresses into links) become plain text.
 */
const toPlain = (md: string) =>
  unescapeText(
    md
      .replace(/(?<!\\)\[((?:\\.|[^\]\\])*)\]\((\S+?)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text} (${url})`))
      .replace(/(?<!\\)(\*\*|__)/g, ""),
  );

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function cleanLines(lines: string[], label: string): string[] {
  const out = lines.flatMap((l) => l.split("\n")).map(clean).filter(Boolean);
  if (out.length > FORM_LIMITS.lines) throw new ApiError("invalid", `${label}: please keep it to ${FORM_LIMITS.lines} lines.`);
  for (const l of out) if (l.length > FORM_LIMITS.line) throw new ApiError("invalid", `${label}: each line can be at most ${FORM_LIMITS.line} characters.`);
  return out;
}

function short(value: string, label: string, max = FORM_LIMITS.short): string {
  const v = clean(value);
  if (v.length > max) throw new ApiError("invalid", `${label} can be at most ${max} characters.`);
  return v;
}

// ---------------------------------------------------------------------------
// Form → Markdown
// ---------------------------------------------------------------------------

/** A photo caption: one line of plain text, escaped. "" for none. */
export function formatCaption(raw: string): string {
  const c = clean(raw);
  if (c.length > FORM_LIMITS.caption) throw new ApiError("invalid", `Photo captions can be at most ${FORM_LIMITS.caption} characters.`);
  return escapeText(c);
}

/** The caption under a picture, from the text blocks after it. Undefined if they don't look like one caption line. */
export function parseCaption(blocks: Block[]): string | undefined {
  const text = blocks.filter((b) => !b.isEmpty);
  if (!text.length) return "";
  if (text.length > 1) return undefined;
  const plain = toPlain(text[0]!.markdown).replace(/\s+/g, " ").trim();
  return plain.length > FORM_LIMITS.caption * 2 || /^\s*([-*+]|\d+[.)])\s/m.test(text[0]!.markdown) ? undefined : plain;
}

/** The recipe body (no heading) for these form values. Throws ApiError("invalid") with a plain message on bad input. */
export function formatRecipe(f: Omit<RecipeForm, "photos">): string {
  const headChef = short(f.headChef, "Head chef", FORM_LIMITS.name);
  const helpers = short(f.helpers, "Helpers", FORM_LIMITS.name);
  const serves = short(f.serves, "Serves");
  const cost = short(f.cost, "Cost");
  const ingredients = cleanLines(f.ingredients, "Ingredients");
  const method = cleanLines(f.method, "Method");
  const tips = cleanLines(f.tips, "Tips & substitutions");
  const story = f.story.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (story.length > FORM_LIMITS.story) throw new ApiError("invalid", `The story can be at most ${FORM_LIMITS.story} characters.`);
  if (f.date && !formatDate(f.date)) throw new ApiError("invalid", "Please pick the date from the calendar.");

  const label = (name: string, value?: string) => `**${name}${value === undefined ? "" : `: ${value}`}**`;
  const blocks: string[] = [label("Head Chef", headChef ? escapeText(headChef) : "???"), label("Support", helpers ? escapeText(helpers) : "???")];
  if (serves) blocks.push(label("Serves", escapeText(serves)));
  if (cost) blocks.push(label("Cost", escapeText(cost)));
  blocks.push(label("Ingredients"));
  if (ingredients.length) blocks.push(ingredients.map((l) => `- ${escapeText(l)}`).join("\n"));
  blocks.push(label("Method"));
  if (method.length) blocks.push(method.map((l, i) => `${i + 1}. ${escapeText(l)}`).join("\n"));
  if (tips.length) blocks.push(label("Tips & substitutions"), tips.map((l) => `- ${escapeText(l)}`).join("\n"));
  if (story) blocks.push(label("Story"), ...story.split(/\n\n/).map(escapeText));
  // Already Markdown from the document, written back as it was. docs.plus reads a literal "# text" paragraph back
  // without its escape, so escape a leading # again (otherwise it would become a heading, which the input check refuses).
  if (f.other.trim()) blocks.push(f.other.trim().replace(/^(\s*)#/gm, "$1\\#"));
  if (f.date) blocks.push(formatDate(f.date));
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Markdown → Form
// ---------------------------------------------------------------------------

type Field = "ingredients" | "method" | "tips" | "story" | null;

const LABELS: Array<[RegExp, Exclude<Field, null>]> = [
  [/^ingr[ie]dients?:?$/i, "ingredients"],
  [/^(method|steps|instructions|directions):?$/i, "method"],
  [/^(tips( (&|and) substitutions)?|substitutions|tips):?$/i, "tips"],
  [/^(story|the story|story behind the dish):?$/i, "story"],
];
const VALUE_LABELS: Array<[RegExp, "headChef" | "helpers" | "serves" | "cost"]> = [
  [/^head chef:\s*(.*)$/i, "headChef"],
  [/^support:\s*(.*)$/i, "helpers"],
  [/^serves:\s*(.*)$/i, "serves"],
  [/^(?:approx(?:imate)?\.? )?cost:\s*(.*)$/i, "cost"],
];

/** A whole block that is just bold text, e.g. "**Method**". Returns the inner Markdown (escapes kept). */
const boldOnly = (md: string) => /^\*\*((?:\\.|[^*\\])+)\*\*$/.exec(md.trim())?.[1]?.trim();

const listItems = (md: string) =>
  md
    .split("\n")
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)?.[1] ?? l)
    .map((l) => toPlain(l).trim())
    .filter(Boolean);

/** Turn a recipe section's blocks into form values. Nothing is dropped: unrecognised text lands in `other`. */
export function parseRecipe(blocks: Block[]): RecipeForm {
  const f = emptyForm();
  const other: string[] = [];
  const story: string[] = [];
  let field: Field = null;

  for (const b of blocks) {
    if (b.isEmpty) continue;
    const md = b.markdown.trim();
    const bold = boldOnly(md);
    const plain = (bold !== undefined ? unescapeText(bold) : toPlain(md.replace(/^#{1,6}\s*/, ""))).trim();

    const date = parseDate(plain);
    if (date && !f.date) {
      f.date = date;
      field = null;
      continue;
    }
    const valued = VALUE_LABELS.find(([re]) => re.test(plain));
    // Labels count bold or not: volunteers type "Ingredients" plain too. Inside the story, only bold value labels count.
    if (valued && (bold !== undefined || field !== "story")) {
      const v = valued[0].exec(plain)![1]!.trim();
      f[valued[1]] = /^\?+$/.test(v) ? "" : v;
      field = null;
      continue;
    }
    const label = LABELS.find(([re]) => re.test(plain));
    if (label) {
      field = label[1];
      continue;
    }

    if (field === "story") story.push(toPlain(md));
    else if (field) f[field].push(...listItems(md));
    else other.push(md);
  }
  f.story = story.join("\n\n");
  f.other = other.join("\n\n");
  return f;
}
