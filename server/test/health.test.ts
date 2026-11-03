import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { NeedsLoginError } from "../src/auth/DocsPlusOAuthProvider.js";
import { DocsPlusError } from "../src/docsPlus.js";
import { Health } from "../src/health.js";
import { InMemoryLock } from "../src/lock.js";
import { RecipesService } from "../src/recipes.js";
import { booklet } from "./fakeDocs.js";

afterEach(() => vi.restoreAllMocks());

function setup(failWith?: () => unknown) {
  let t = 1_000_000;
  let probes = 0;
  let fail = failWith;
  const health = new Health({
    probe: async () => {
      probes++;
      if (fail) throw fail();
    },
    now: () => t,
  });
  return { health, probes: () => probes, tick: (ms: number) => (t += ms), setFail: (f?: () => unknown) => (fail = f) };
}

describe("docs.plus health", () => {
  it("trusts a recent real success without calling docs.plus", async () => {
    const s = setup();
    s.health.noteSuccess();
    expect(await s.health.check()).toMatchObject({ ok: true, docsPlus: "ok" });
    expect(s.probes()).toBe(0);
  });

  it("otherwise probes at most once a minute, sharing concurrent checks", async () => {
    const s = setup();
    await Promise.all([s.health.check(), s.health.check(), s.health.check()]);
    expect(s.probes()).toBe(1);
    s.tick(6 * 60_000); // the probe's own success is now stale
    await s.health.check();
    expect(s.probes()).toBe(2);
  });

  it("names the problem: login needed, not the owner, or unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const login = setup(() => new NeedsLoginError());
    expect(await login.health.check()).toEqual({ ok: false, docsPlus: "login_needed" });
    const owner = setup(() => new DocsPlusError("not_owner", "get_outline", "not yours"));
    expect((await owner.health.check()).docsPlus).toBe("not_owner");
    const down = setup(() => new Error("ECONNRESET"));
    expect((await down.health.check()).docsPlus).toBe("unavailable");
  });

  it("caches a failure for a minute, then recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup(() => new NeedsLoginError());
    await s.health.check();
    s.setFail(undefined);
    expect((await s.health.check()).ok).toBe(false); // cached
    s.tick(61_000);
    expect((await s.health.check()).ok).toBe(true);
    expect(s.probes()).toBe(2);
  });
});

describe("health routes", () => {
  const app = (health?: Health) => createApp({ recipes: new RecipesService({ docs: booklet(), lock: new InMemoryLock(), slug: "fake" }), health });

  it("/health is always 200 and never touches docs.plus", async () => {
    const s = setup(() => new NeedsLoginError());
    const r = await app(s.health).request("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(s.probes()).toBe(0);
  });

  it("/health/docs is 503 with the reason when docs.plus can't be used, 200 when it can", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = await app(setup(() => new NeedsLoginError()).health).request("/health/docs");
    expect(bad.status).toBe(503);
    expect(await bad.json()).toEqual({ status: "degraded", docsPlus: "login_needed" });

    const good = setup();
    const r = await app(good.health).request("/health/docs");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", docsPlus: "ok", lastSuccess: expect.any(String) });
  });
});
