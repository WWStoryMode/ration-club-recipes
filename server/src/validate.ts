import { MEDIA_PLACEHOLDER } from "./docsPlus.js";
import { ApiError } from "./errors.js";

export const LIMITS = { sectionChars: 20_000, titleChars: 100, texts: 50 };

/** Line endings to \n, at most one blank line in a row, trimmed. */
export function normalizeMarkdown(md: string): string {
  return md.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Rules for text submitted by anonymous visitors. Anything that creates something permanent in docs.plus
 * (headings become sections, media can't be removed through MCP) or that only looks like media is refused.
 * The full clean-up pass (HTML, length policy, moderation) comes in a later phase.
 */
const RULES: Array<[RegExp, string]> = [
  [/^ {0,3}#{1,6}(\s|$)/m, "Headings can't be added. Use **bold text** for labels like Ingredients or Method."],
  [/!\[[^\]]*\]\([^)]*\)/, "Pictures can't be added here."],
  [MEDIA_PLACEHOLDER, "Text like [image] or [youtube] is reserved for pictures and videos. Please reword it."],
  [/^\s*<?https?:\/\/\S+>?\s*$/m, "A link on a line by itself would become an embedded video or page. Put some words before or after it."],
  [/^\s*(```|~~~)/m, "Code blocks and diagrams can't be added."],
  [/<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i, "HTML tags aren't allowed."],
];

export function checkVisitorMarkdown(md: string, label = "Text"): string {
  const text = normalizeMarkdown(md);
  if (text.length > LIMITS.sectionChars) {
    throw new ApiError("invalid", `${label} is too long (${text.length} characters, the limit is ${LIMITS.sectionChars}).`);
  }
  for (const [re, msg] of RULES) if (re.test(text)) throw new ApiError("invalid", msg);
  return text;
}

export function checkTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) throw new ApiError("invalid", "Please give the recipe a name.");
  if (title.length > LIMITS.titleChars) throw new ApiError("invalid", `Recipe names can be at most ${LIMITS.titleChars} characters.`);
  if (/[#*_`<>[\]|\\~]/.test(title)) throw new ApiError("invalid", "Recipe names can't contain # * _ ` < > [ ] | \\ or ~.");
  return title;
}
