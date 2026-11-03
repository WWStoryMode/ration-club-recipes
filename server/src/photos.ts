import { lookup as dnsLookup } from "node:dns";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import path from "node:path";
import { ApiError } from "./errors.js";
import { InMemoryLock } from "./lock.js";

/**
 * Recipe photos are links to images hosted elsewhere. docs.plus doesn't copy them: every reader's browser loads the
 * picture from that link. We never store images. Two things live here:
 *  - checkImageLink: before a link is accepted, the server fetches it once to make sure it really is an image.
 *    That fetch must never reach our own machine or private network (SSRF), so every address it connects to is
 *    checked, including after redirects.
 *  - PhotoLinks: docs.plus reads pictures back only as "[image]", so we keep our own record of which links went
 *    into which recipe, in order, to show them on our page.
 */

export const PHOTO_LIMITS = { perSave: 3, perRecipe: 6, caption: 200, url: 1000, bytes: 5 * 1024 * 1024 };

export const PHOTO_MESSAGES = {
  https: "Photo links must start with https://",
  notImage: "That link doesn't lead straight to a picture. Open the photo on its own (for example right-click it and choose \"Copy image address\") and paste that link.",
  unreachable: "We couldn't open that photo link. Check it works in your browser, or try another link.",
  tooBig: "That photo is too large (over 5 MB). Please link a smaller version.",
  blocked: "That photo link isn't allowed.",
};

// ---------------------------------------------------------------------------
// Which addresses the checker may connect to
// ---------------------------------------------------------------------------

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** True for loopback, private, link-local, metadata and other non-public addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  const v = isIP(ip);
  if (!v) return true;
  return PRIVATE.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/** DNS lookup that refuses to hand back a non-public address, so the connection itself can't go there. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as Array<{ address: string; family: number }>;
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

// ---------------------------------------------------------------------------
// Link check
// ---------------------------------------------------------------------------

/** Tidy and validate the text of a link. Throws ApiError("invalid") with a plain message. */
export function normaliseLink(raw: string): URL {
  const text = raw.trim();
  if (!text) throw new ApiError("invalid", "Please paste a photo link.");
  if (text.length > PHOTO_LIMITS.url) throw new ApiError("invalid", "That photo link is too long.");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new ApiError("invalid", "That doesn't look like a link. It should start with https://");
  }
  if (u.protocol !== "https:") throw new ApiError("invalid", PHOTO_MESSAGES.https);
  if (u.username || u.password) throw new ApiError("invalid", PHOTO_MESSAGES.blocked);
  if (u.port && u.port !== "443") throw new ApiError("invalid", PHOTO_MESSAGES.blocked);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost" || !host.includes(".") || /\.(local|internal|localhost)$/i.test(host)) {
    throw new ApiError("invalid", PHOTO_MESSAGES.blocked);
  }
  u.hash = "";
  return u;
}

export type ImageKind = "jpeg" | "png" | "gif" | "webp";

/** Recognise an image by its first bytes, not by what the server claims. */
export function sniffImage(b: Uint8Array): ImageKind | undefined {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return undefined;
}

/** One GET of the start of the file. Never follows redirects itself. */
export type Probe = (url: URL) => Promise<{ status: number; location?: string; contentType?: string; length?: number; head: Uint8Array }>;

/** The real probe: https only, safe DNS (no private addresses), 8 s timeout, reads at most the first 64 KB. */
export const httpsProbe: Probe = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: safeLookup, timeout: 8000, headers: { "user-agent": "RationClubRecipes/1 (photo link check)", accept: "image/*" } }, (res) => {
      const chunks: Buffer[] = [];
      let got = 0;
      const done = () => {
        res.destroy();
        const len = Number(res.headers["content-length"]);
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          contentType: res.headers["content-type"],
          length: Number.isFinite(len) ? len : undefined,
          head: new Uint8Array(Buffer.concat(chunks)),
        });
      };
      if ((res.statusCode ?? 0) >= 300) return done();
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        got += c.length;
        if (got >= 64 * 1024) done();
      });
      res.on("end", done);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });

/**
 * Check that a link leads straight to an image people can see: https, public address, at most 3 redirects (each
 * re-checked), a JPEG/PNG/GIF/WebP by its first bytes, and not over 5 MB when the size is given.
 * Returns the link to use (the original one: docs.plus will load that, and follow redirects itself).
 */
export async function checkImageLink(raw: string, probe: Probe = httpsProbe): Promise<string> {
  const original = normaliseLink(raw);
  let url = original;
  for (let hop = 0; hop <= 3; hop++) {
    let r: Awaited<ReturnType<Probe>>;
    try {
      r = await probe(url);
    } catch (err) {
      if ((err as { code?: string }).code === "EBLOCKED") throw new ApiError("invalid", PHOTO_MESSAGES.blocked, { reason: "photo_private_address" });
      throw new ApiError("invalid", PHOTO_MESSAGES.unreachable, { reason: `photo_unreachable:${(err as Error).message}` });
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = normaliseLink(new URL(r.location, url).href); // redirects must also be https and public
      continue;
    }
    if (r.status !== 200 && r.status !== 206) throw new ApiError("invalid", PHOTO_MESSAGES.unreachable, { reason: `photo_status:${r.status}` });
    if (r.length && r.length > PHOTO_LIMITS.bytes) throw new ApiError("invalid", PHOTO_MESSAGES.tooBig, { reason: "photo_too_big" });
    if (!sniffImage(r.head)) throw new ApiError("invalid", PHOTO_MESSAGES.notImage, { reason: `photo_not_image:${r.contentType ?? "?"}` });
    return original.href;
  }
  throw new ApiError("invalid", PHOTO_MESSAGES.unreachable, { reason: "photo_redirects" });
}

/** Markdown for a photo block and its caption. The link is percent-encoded so it can't break out of the (…). */
export function photoMarkdown(url: string, captionMd: string, altText: string): string {
  // encodeURIComponent leaves ( and ) alone, and a ")" would end the Markdown link early: encode them by hand.
  const safeUrl = url.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  const alt = altText.replace(/[[\]\\\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Recipe photo";
  return `![${alt}](${safeUrl})${captionMd ? `\n\n${captionMd}` : ""}`;
}

// ---------------------------------------------------------------------------
// Our record of photo links per recipe
// ---------------------------------------------------------------------------

export interface PhotoLinkStore {
  /** Links added to a recipe, oldest first. */
  get(recipeId: string): Promise<string[]>;
  add(recipeId: string, urls: string[]): Promise<void>;
}

/** DATA_DIR/photo-links.json. Small, rewritten atomically. */
export class FilePhotoLinks implements PhotoLinkStore {
  private readonly lock = new InMemoryLock();

  constructor(private readonly file: string) {}

  private async all(): Promise<Record<string, string[]>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, string[]>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async get(recipeId: string): Promise<string[]> {
    return (await this.all())[recipeId] ?? [];
  }

  add(recipeId: string, urls: string[]): Promise<void> {
    return this.lock.withLock("photos", async () => {
      const all = await this.all();
      all[recipeId] = [...(all[recipeId] ?? []), ...urls];
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
  }
}

export class MemoryPhotoLinks implements PhotoLinkStore {
  data: Record<string, string[]> = {};
  async get(id: string) {
    return this.data[id] ?? [];
  }
  async add(id: string, urls: string[]) {
    this.data[id] = [...(this.data[id] ?? []), ...urls];
  }
}
