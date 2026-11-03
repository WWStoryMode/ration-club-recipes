import { describe, expect, it } from "vitest";
import { bootstrapLogin, decodeBundle, encodeBundle, exportBundle, type LoginBundle } from "../src/bootstrap.js";
import { MemoryStore } from "./memoryStore.js";

const quiet = { log: () => {}, warn: () => {} };
const bundle: LoginBundle = {
  v: 1,
  client: { client_id: "c1" },
  tokens: { access_token: "at", token_type: "bearer", refresh_token: "rt", expires_in: 3600, obtained_at: 1 },
  discovery: { authorizationServerUrl: "https://auth.example" },
};

describe("login bundle", () => {
  it("round-trips through export/encode/decode", async () => {
    const s = new MemoryStore();
    await s.set("client", bundle.client);
    await s.set("tokens", bundle.tokens);
    await s.set("discovery", bundle.discovery!);
    expect(decodeBundle(encodeBundle(await exportBundle(s)))).toEqual(bundle);
  });

  it("imports into an empty store", async () => {
    const s = new MemoryStore();
    expect(await bootstrapLogin(s, encodeBundle(bundle), quiet)).toBe("imported");
    expect(await s.get("tokens")).toEqual(bundle.tokens);
    expect(await s.get("client")).toEqual(bundle.client);
  });

  it("never overwrites an existing login", async () => {
    const s = new MemoryStore();
    await s.set("tokens", { ...bundle.tokens, refresh_token: "newer" });
    const warnings: string[] = [];
    expect(await bootstrapLogin(s, encodeBundle(bundle), { log: () => {}, warn: (m: string) => warnings.push(m) })).toBe("existing");
    expect((await s.get("tokens"))?.refresh_token).toBe("newer");
    expect(warnings[0]).toMatch(/NOT imported/);
  });

  it("does nothing without a bundle", async () => {
    expect(await bootstrapLogin(new MemoryStore(), undefined, quiet)).toBe("none");
    expect(await bootstrapLogin(new MemoryStore(), "  ", quiet)).toBe("none");
  });

  it("rejects malformed or incomplete bundles", async () => {
    await expect(bootstrapLogin(new MemoryStore(), "not base64 json", quiet)).rejects.toThrow(/not a valid bundle/);
    const incomplete = Buffer.from(JSON.stringify({ v: 1, client: { client_id: "c" }, tokens: { access_token: "a" } })).toString("base64");
    await expect(bootstrapLogin(new MemoryStore(), incomplete, quiet)).rejects.toThrow(/incomplete/);
  });

  it("export refuses a store without a refresh token", async () => {
    await expect(exportBundle(new MemoryStore())).rejects.toThrow(/pnpm run login/);
  });
});
