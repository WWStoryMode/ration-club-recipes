import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The visitor's IP, for rate limits and the (hashed) audit log.
 * - No header configured: the TCP peer address (right for local runs; behind a proxy it's the proxy's address).
 * - "x-forwarded-for": the RIGHT-most entry, which the host's proxy appended. Entries to its left come from the
 *   visitor and can be faked.
 * - Any other header (e.g. "fly-client-ip"): its value, which the host sets and overwrites.
 * Only name a header your host really sets, or visitors can fake their IP and dodge the limits.
 */
export function clientIp(c: Context, header?: string): string {
  if (header) {
    const raw = c.req.header(header);
    const ip = header.toLowerCase() === "x-forwarded-for" ? raw?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) : raw?.trim();
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // e.g. in tests, where there is no socket
  }
}
