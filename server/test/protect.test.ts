import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { FileAuditLog, ipHasher, loadSalt, truncate } from "../src/protect/audit.js";
import { clientIp } from "../src/protect/clientIp.js";
import { parseRate, RateLimiter } from "../src/protect/rateLimit.js";
import { Turnstile } from "../src/protect/turnstile.js";
import { checkTitle, checkVisitorMarkdown, normalizeMarkdown } from "../src/validate.js";

describe("input cleaning", () => {
  it("removes invisible and direction-changing characters, keeps emoji joiners, normalises accents", () => {
    expect(normalizeMarkdown("pay ‮ecnalab‬ now​﻿")).toBe("pay ecnalab now");
    expect(normalizeMarkdown("a\u0000b\u0007c\u009Fd")).toBe("abcd");
    expect(normalizeMarkdown("👨‍👩‍👧")).toBe("👨‍👩‍👧");
    expect(normalizeMarkdown("café")).toBe("café");
  });

  it.each([
    ["[x](javascript:alert(1))"],
    ["[x](JAVASCRIPT:alert(1))"],
    ["[x]( data:text/html,hi)"],
    ["[x](/relative/path)"],
    ["<javascript:alert(1)>"],
    ["<file:///etc/passwd>"],
  ])("refuses unsafe link %s", (md) => {
    expect(() => checkVisitorMarkdown(md)).toThrow(/Links must be web addresses/);
  });

  it("allows web and email links, and at most 5 of them", () => {
    expect(checkVisitorMarkdown("see [site](https://a.example) or [mail](mailto:a@b.example)")).toContain("https://a.example");
    const six = Array.from({ length: 6 }, (_, i) => `https://x${i}.example`).join(" and ");
    expect(() => checkVisitorMarkdown(`links: ${six}`)).toThrow(/at most 5 links/);
  });

  it("cannot be tricked by hidden characters inside a heading or HTML", () => {
    expect(() => checkVisitorMarkdown("​## Sneaky")).toThrow(/Headings/);
    expect(() => checkVisitorMarkdown("<scr​ipt>")).toThrow(/HTML/);
  });

  it("cleans titles too", () => {
    expect(checkTitle(" Lentil‮ Soup​ ")).toBe("Lentil Soup");
  });
});

describe("clientIp", () => {
  const ipOf = async (headers: Record<string, string>, header?: string) => {
    const app = new Hono();
    app.get("/", (c) => c.text(clientIp(c, header)));
    return (await app.request("/", { headers })).text();
  };
  it("uses the right-most X-Forwarded-For entry (the one the host's proxy added)", async () => {
    expect(await ipOf({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "x-forwarded-for")).toBe("1.2.3.4");
  });
  it("uses a host header like Fly-Client-IP as is", async () => {
    expect(await ipOf({ "fly-client-ip": "9.9.9.9", "x-forwarded-for": "6.6.6.6" }, "fly-client-ip")).toBe("9.9.9.9");
  });
  it("ignores spoofable headers when none is configured", async () => {
    expect(await ipOf({ "x-forwarded-for": "6.6.6.6" })).toBe("unknown");
  });
});

describe("RateLimiter", () => {
  it("allows the limit per window per key, then reports seconds to wait", () => {
    let t = 0;
    const r = new RateLimiter(2, 60_000, () => t);
    expect(r.take("a").ok).toBe(true);
    expect(r.take("a").ok).toBe(true);
    t = 15_000;
    expect(r.take("a")).toEqual({ ok: false, retryAfter: 45 });
    expect(r.take("b").ok).toBe(true);
    t = 60_000;
    expect(r.take("a").ok).toBe(true);
  });
  it("parses count/seconds", () => {
    expect(parseRate(undefined, "10/600")).toEqual({ limit: 10, windowMs: 600_000 });
    expect(() => parseRate("ten", "10/600")).toThrow(/count\/seconds/);
  });
});

describe("Turnstile", () => {
  const fake = (reply: unknown, seen: URLSearchParams[] = []) =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.push(new URLSearchParams(String(init?.body)));
      return Response.json(reply);
    }) as typeof fetch;
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: ApiError) => `${e.code}:${e.extra.reason}`);

  it("passes a valid token and sends secret, token and IP", async () => {
    const seen: URLSearchParams[] = [];
    await new Turnstile({ secret: "s", siteKey: "k", fetch: fake({ success: true, hostname: "recipes.example" }, seen) }).verify("tok", "1.2.3.4");
    expect(Object.fromEntries(seen[0]!)).toEqual({ secret: "s", response: "tok", remoteip: "1.2.3.4" });
  });
  it("refuses missing, failed, wrong-hostname and unreachable checks", async () => {
    const t = (reply: unknown, hostnames?: string[]) => new Turnstile({ secret: "s", siteKey: "k", hostnames, fetch: fake(reply) });
    expect(await code(t({ success: true }).verify(undefined, "ip"))).toBe("invalid:turnstile_missing");
    expect(await code(t({ success: false, "error-codes": ["timeout-or-duplicate"] }).verify("tok", "ip"))).toBe("invalid:turnstile_failed:timeout-or-duplicate");
    expect(await code(t({ success: true, hostname: "evil.example" }, ["recipes.example"]).verify("tok", "ip"))).toBe("invalid:turnstile_hostname");
    const down = new Turnstile({ secret: "s", siteKey: "k", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await code(down.verify("tok", "ip"))).toBe("unavailable:turnstile_unreachable");
  });
});

describe("audit log", () => {
  it("appends one JSON line per entry into a daily file, private to the owner", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "rcr-audit-")), "audit");
    const log = new FileAuditLog(dir);
    const base = { requestId: "r", action: "save_section" as const, ipHash: "h" };
    await log.write({ ...base, ts: "2026-11-03T10:00:00.000Z", outcome: "saved" });
    await log.write({ ...base, ts: "2026-11-03T11:00:00.000Z", outcome: "conflict" });
    await log.write({ ...base, ts: "2026-11-04T09:00:00.000Z", outcome: "refused" });
    const day1 = (await readFile(path.join(dir, "audit-2026-11-03.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(day1.map((e) => e.outcome)).toEqual(["saved", "conflict"]);
    expect((await stat(path.join(dir, "audit-2026-11-03.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("hashes IPs with a salt: stable per salt, different across salts, never the IP itself", () => {
    const a = ipHasher("salt-a");
    expect(a("1.2.3.4")).toBe(a("1.2.3.4"));
    expect(a("1.2.3.4")).not.toBe(a("1.2.3.5"));
    expect(a("1.2.3.4")).not.toBe(ipHasher("salt-b")("1.2.3.4"));
    expect(a("1.2.3.4")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("creates a salt once and reuses it; AUDIT_SALT wins", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rcr-salt-"));
    const s1 = await loadSalt(dir);
    expect(await loadSalt(dir)).toBe(s1);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(path.join(dir, "audit-salt"))).mode & 0o777).toBe(0o600);
    expect(await loadSalt(dir, " fixed ")).toBe("fixed");
  });

  it("truncates long attempted text", () => {
    expect(truncate(["x".repeat(2005)])![0]).toBe(`${"x".repeat(2000)}…[+5]`);
  });
});
