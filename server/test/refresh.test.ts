import { describe, expect, it } from "vitest";
import { NeedsLoginError } from "../src/auth/DocsPlusOAuthProvider.js";
import { dedupeRefreshFetch, TokenRefresher } from "../src/auth/refresh.js";
import { makeProvider } from "../src/mcp.js";
import { MemoryStore } from "./memoryStore.js";

const AS = "https://auth.example";
const refreshBody = (rt: string) => new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: "c1" });

/** A fake token endpoint that rotates refresh tokens: rt-N → rt-(N+1). Counts calls and refuses spent tokens. */
function fakeAuthServer(delayMs = 5) {
  const spent = new Set<string>();
  let calls = 0;
  const fetchFn = async (_url: string | URL, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    if (p.get("grant_type") !== "refresh_token") return new Response("other", { status: 200 });
    calls++;
    await new Promise((r) => setTimeout(r, delayMs));
    const rt = p.get("refresh_token")!;
    if (spent.has(rt)) return Response.json({ error: "invalid_grant", error_description: "Refresh Token Already Used" }, { status: 400 });
    spent.add(rt);
    const n = Number(rt.split("-")[1]) + 1;
    return Response.json({ access_token: `at-${n}`, token_type: "bearer", expires_in: 3600, refresh_token: `rt-${n}` });
  };
  return { fetchFn, calls: () => calls };
}

describe("dedupeRefreshFetch", () => {
  it("shares one upstream call between concurrent identical refreshes", async () => {
    const as = fakeAuthServer();
    const f = dedupeRefreshFetch(as.fetchFn, { quiet: true });
    const res = await Promise.all(Array.from({ length: 5 }, () => f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") })));
    expect(as.calls()).toBe(1);
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.refresh_token))).toEqual(new Set(["rt-2"]));
  });

  it("answers a late caller with the old token from cache instead of spending it again", async () => {
    let t = 0;
    const as = fakeAuthServer(0);
    const f = dedupeRefreshFetch(as.fetchFn, { now: () => t, quiet: true });
    await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") });
    t = 59_000;
    const late = await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") });
    expect(late.status).toBe(200);
    expect((await late.json()).refresh_token).toBe("rt-2");
    expect(as.calls()).toBe(1);
    t = 61_000; // after the window the token is spent: the server refuses, as it should
    expect((await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") })).status).toBe(400);
  });

  it("keys on the refresh token: a different token is a new call", async () => {
    const as = fakeAuthServer(0);
    const f = dedupeRefreshFetch(as.fetchFn, { quiet: true });
    await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") });
    await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-2").toString() }); // string bodies are understood too
    expect(as.calls()).toBe(2);
  });

  it("does not replay failures, so a refresh can be retried after a server error", async () => {
    let calls = 0;
    const f = dedupeRefreshFetch(async () => (++calls === 1 ? new Response("boom", { status: 500 }) : Response.json({ refresh_token: "rt-2" })));
    expect((await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") })).status).toBe(500);
    expect((await f(`${AS}/token`, { method: "POST", body: refreshBody("rt-1") })).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("passes other requests straight through", async () => {
    let seen = 0;
    const f = dedupeRefreshFetch(async () => {
      seen++;
      return new Response("ok");
    });
    await f(`${AS}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0" }) });
    await f(`${AS}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0" }) });
    await f(`${AS}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: "x" }) });
    expect(seen).toBe(3);
  });
});

describe("TokenRefresher", () => {
  async function setup(obtainedAgoMs: number, now = 10_000_000) {
    const store = new MemoryStore();
    await store.set("client", { client_id: "c1" });
    await store.set("discovery", {
      authorizationServerUrl: AS,
      authorizationServerMetadata: { issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, response_types_supported: ["code"] },
    });
    await store.set("tokens", { access_token: "at-1", token_type: "bearer", expires_in: 3600, refresh_token: "rt-1", obtained_at: now - obtainedAgoMs });
    const as = fakeAuthServer();
    const r = new TokenRefresher({ store, provider: makeProvider(store), serverUrl: "https://mcp.example/api/mcp", fetch: dedupeRefreshFetch(as.fetchFn, { quiet: true }), now: () => now });
    return { store, as, r };
  }

  it("does nothing while the token has more than 5 minutes left", async () => {
    const { r, as } = await setup(30 * 60_000);
    await r.ensureFresh();
    expect(as.calls()).toBe(0);
  });

  it("refreshes once for many concurrent callers near expiry, and saves the rotated token with its issuer", async () => {
    const { r, as, store } = await setup(57 * 60_000);
    await Promise.all(Array.from({ length: 5 }, () => r.ensureFresh()));
    expect(as.calls()).toBe(1);
    expect(await store.get("tokens")).toMatchObject({ access_token: "at-2", refresh_token: "rt-2", issuer: AS });
  });

  it("refreshes an already-expired token", async () => {
    const { r, store } = await setup(2 * 3600_000);
    await r.ensureFresh();
    expect((await store.get("tokens"))?.refresh_token).toBe("rt-2");
  });

  it("needs a login when there are no tokens or no refresh token", async () => {
    const empty = new MemoryStore();
    await expect(new TokenRefresher({ store: empty, provider: makeProvider(empty), serverUrl: "x" }).ensureFresh()).rejects.toBeInstanceOf(NeedsLoginError);
    const { r, store } = await setup(2 * 3600_000);
    const t = (await store.get("tokens"))!;
    delete t.refresh_token;
    await store.set("tokens", t);
    await expect(r.ensureFresh()).rejects.toBeInstanceOf(NeedsLoginError);
  });
});
