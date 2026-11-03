import { MEDIA_PLACEHOLDER } from "./docsPlus.js";
import { ApiError } from "./errors.js";

export const LIMITS = { sectionChars: 20_000, titleChars: 100, texts: 50, links: 5 };

/**
 * Characters people can't see but that change meaning or display:
 * - control characters (except tab and newline);
 * - text-direction overrides, which can make text read differently from how it is stored ("Trojan Source");
 * - zero-width spaces and BOMs.
 * Zero-width (non-)joiners (U+200C/U+200D) are kept: emoji and several scripts need them.
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Unicode NFC, invisible characters removed, \n line endings, no trailing spaces, at most one blank line in a row, trimmed. */
export function normalizeMarkdown(md: string): string {
  return md
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Rules for text submitted by anonymous visitors. Anything that creates something permanent in docs.plus
 * (headings become sections, media can't be removed through MCP) or that only looks like media is refused.
 * Text is normalised first (normalizeMarkdown), so hidden characters can't be used to slip past these rules.
 */
const RULES: Array<[RegExp, string]> = [
  [/^ {0,3}#{1,6}(\s|$)/m, "Headings can't be added. Use **bold text** for labels like Ingredients or Method."],
  [/!\[[^\]]*\]\([^)]*\)/, "Pictures can't be added here."],
  [MEDIA_PLACEHOLDER, "Text like [image] or [youtube] is reserved for pictures and videos. Please reword it."],
  [/^\s*<?https?:\/\/\S+>?\s*$/m, "A link on a line by itself would become an embedded video or page. Put some words before or after it."],
  [/^\s*(```|~~~)/m, "Code blocks and diagrams can't be added."],
  [/<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i, "HTML tags aren't allowed."],
  // Markdown links and <autolinks> must be web or email addresses (no javascript:, data:, file:, relative paths…).
  [/\]\(\s*<?(?!https?:\/\/|mailto:)[^)\s]*/i, "Links must be web addresses starting with https:// (or email addresses with mailto:)."],
  [/<(?!https?:\/\/|mailto:)[a-z][a-z0-9+.-]*:[^>\s]*>/i, "Links must be web addresses starting with https:// (or email addresses with mailto:)."],
];

export function checkVisitorMarkdown(md: string, label = "Text"): string {
  const text = normalizeMarkdown(md);
  if (text.length > LIMITS.sectionChars) {
    throw new ApiError("invalid", `${label} is too long (${text.length} characters, the limit is ${LIMITS.sectionChars}).`);
  }
  for (const [re, msg] of RULES) if (re.test(text)) throw new ApiError("invalid", msg);
  const links = text.match(/https?:\/\//gi)?.length ?? 0;
  if (links > LIMITS.links) throw new ApiError("invalid", `Please include at most ${LIMITS.links} links in one change.`);
  return text;
}

export function checkTitle(raw: string): string {
  const title = normalizeMarkdown(raw).replace(/\s+/g, " ").trim();
  if (!title) throw new ApiError("invalid", "Please give the recipe a name.");
  if (title.length > LIMITS.titleChars) throw new ApiError("invalid", `Recipe names can be at most ${LIMITS.titleChars} characters.`);
  if (/[#*_`<>[\]|\\~]/.test(title)) throw new ApiError("invalid", "Recipe names can't contain # * _ ` < > [ ] | \\ or ~.");
  return title;
}
