import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { NeedsLoginError } from "../src/auth/DocsPlusOAuthProvider.js";
import { DocsPlusError } from "../src/docsPlus.js";
import { LazyDocs } from "../src/lazyDocs.js";
import type { DocsPort } from "../src/recipes.js";
import { MemoryStore } from "./memoryStore.js";

function setup(failures: unknown[]) {
  let connects = 0;
  let calls = 0;
  let refreshes = 0;
  const dp = {
    getOutline: async () => {
      calls++;
      const f = failures.shift();
      if (f) throw f;
      return { slug: "s", ownedByYou: true, nodes: [] };
    },
  } as unknown as DocsPort;
  const lazy = new LazyDocs("s", {
    store: new MemoryStore(),
    refresher: { ensureFresh: async () => void refreshes++ },
    connect: async () => {
      connects++;
      return { client: { close: async () => {} } as unknown as Client, dp };
    },
  });
  return { lazy, stats: () => ({ connects, calls, refreshes }) };
}

const unauth = () => new StreamableHTTPError(401, "Server returned 401 after successful authentication");

describe("LazyDocs", () => {
  it("checks the token before every call and reuses one connection", async () => {
    const { lazy, stats } = setup([]);
    await lazy.getOutline();
    await lazy.getOutline();
    expect(stats()).toEqual({ connects: 1, calls: 2, refreshes: 2 });
  });

  it("retries a 401 once on the same connection", async () => {
    const { lazy, stats } = setup([unauth()]);
    await expect(lazy.getOutline()).resolves.toMatchObject({ slug: "s" });
    expect(stats()).toMatchObject({ connects: 1, calls: 2 });
  });

  it("two 401s in a row mean the login is gone", async () => {
    const { lazy } = setup([unauth(), unauth()]);
    await expect(lazy.getOutline()).rejects.toBeInstanceOf(NeedsLoginError);
  });

  it("reconnects after a network error, but not after a docs.plus refusal", async () => {
    const { lazy, stats } = setup([new TypeError("fetch failed"), new DocsPlusError("invalid_input", "x", "old_text: nope")]);
    await expect(lazy.getOutline()).rejects.toThrow("fetch failed");
    await expect(lazy.getOutline()).rejects.toBeInstanceOf(DocsPlusError);
    await lazy.getOutline();
    expect(stats().connects).toBe(2);
  });
});
