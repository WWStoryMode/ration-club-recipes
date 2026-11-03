import { afterEach, describe, expect, it, vi } from "vitest";
import { chatText, ChatSummaries, plain, type ChatPort } from "../src/chat.js";

function setup(rooms: string, opts: { fail?: boolean } = {}) {
  let t = 0;
  const posts: Array<[string, string]> = [];
  let lists = 0;
  const port: ChatPort = {
    listChatRooms: async () => {
      lists++;
      return rooms;
    },
    postChatMessage: async (id, text) => {
      if (opts.fail) throw new Error("boom");
      posts.push([id, text]);
    },
  };
  const chat = new ChatSummaries({ chat: port, booklet: async () => "root01", roomsCacheMs: 1000, now: () => t });
  return { chat, posts, lists: () => lists, tick: (ms: number) => (t += ms), setRooms: (r: string) => (rooms = r) };
}

afterEach(() => vi.restoreAllMocks());

describe("chat summaries", () => {
  it("posts in the recipe's room when it has one, else the booklet's", async () => {
    const { chat, posts } = setup("- Pasta Bake [rec01] 3 messages\n- Booklet [root01]");
    chat.notify("rec01", "a");
    chat.notify("rec02", "b");
    chat.notify(undefined, "c");
    await chat.idle();
    expect(posts).toEqual([["rec01", "a"], ["root01", "b"], ["root01", "c"]]);
  });

  it("matches whole ids only", async () => {
    const { chat, posts } = setup("- Booklet [root01] / [rec01x]");
    chat.notify("rec01", "a");
    await chat.idle();
    expect(posts).toEqual([["root01", "a"]]);
  });

  it("skips quietly when no room exists, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chat, posts } = setup("No heading in this document has a chat room yet.");
    chat.notify("rec01", "a");
    chat.notify("rec01", "b");
    await chat.idle();
    expect(posts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("caches the room list, and sees a new room once the cache expires", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup("none");
    s.chat.notify(undefined, "a");
    await s.chat.idle();
    s.setRooms("[root01]");
    s.chat.notify(undefined, "b");
    await s.chat.idle();
    expect(s.lists()).toBe(1);
    s.tick(1000);
    s.chat.notify(undefined, "c");
    await s.chat.idle();
    expect(s.lists()).toBe(2);
    expect(s.posts).toEqual([["root01", "c"]]);
  });

  it("never throws: a failed post is logged and later notes still go out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chat } = setup("[root01]", { fail: true });
    chat.notify(undefined, "a");
    await expect(chat.idle()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("writes plain one-line text with no @", () => {
    expect(plain("hi @everyone\n\nthere")).toBe("hi everyone there");
    expect(chatText.updated("Stew", "Method", false)).toBe('Recipe updated through Ration Club Recipes: "Stew" › Method.');
    expect(chatText.updated("Stew", "Stew", true)).toBe('Recipe updated through Ration Club Recipes: "Stew". Approved by an organiser.');
  });
});
