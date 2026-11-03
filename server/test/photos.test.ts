import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/errors.js";
import { InMemoryLock } from "../src/lock.js";
import { checkImageLink, isPrivateAddress, MemoryPhotoLinks, normaliseLink, photoMarkdown, sniffImage, type Probe } from "../src/photos.js";
import { emptyForm } from "../src/recipeForm.js";
import { RecipesService } from "../src/recipes.js";
import { booklet, FakeDocs } from "./fakeDocs.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const HTML = new TextEncoder().encode("<!doctype html><html>");

/** A fake internet: url → response. */
const net =
  (pages: Record<string, Partial<Awaited<ReturnType<Probe>>>>): Probe =>
  async (u) => {
    const p = pages[u.href];
    if (!p) throw new Error("ENOTFOUND");
    return { status: 200, head: new Uint8Array(), ...p };
  };

async function refused(p: Promise<unknown>, msg: RegExp) {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as Error).message).toMatch(msg);
}

describe("photo link check", () => {
  it("accepts a public https image, recognised by its first bytes", async () => {
    expect(await checkImageLink("https://img.example.org/a.png", net({ "https://img.example.org/a.png": { head: PNG } }))).toBe("https://img.example.org/a.png");
    expect(sniffImage(JPEG)).toBe("jpeg");
  });

  it("refuses links that aren't https, or point at private or odd hosts", () => {
    const bad = ["http://img.example.org/a.png", "ftp://x.org/a", "https://localhost/a.png", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://10.0.0.5/a.png", "https://intranet/a.png", "https://box.local/a.png", "https://u:p@x.org/a.png", "https://x.org:8443/a.png", "javascript:alert(1)", "not a link"];
    for (const u of bad) expect(() => normaliseLink(u), u).toThrow(ApiError);
  });

  it("knows which addresses are private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("follows up to 3 redirects, checking each target, and keeps the original link", async () => {
    const probe = net({
      "https://short.example/x": { status: 302, location: "https://cdn.example.org/x.jpg" },
      "https://cdn.example.org/x.jpg": { head: JPEG },
    });
    expect(await checkImageLink("https://short.example/x", probe)).toBe("https://short.example/x");
    await refused(checkImageLink("https://short.example/y", net({ "https://short.example/y": { status: 301, location: "http://169.254.169.254/latest/meta-data" } })), /https/);
    await refused(checkImageLink("https://short.example/z", net({ "https://short.example/z": { status: 302, location: "https://127.0.0.1/" } })), /isn't allowed/);
    const loop = net({ "https://a.example/1": { status: 302, location: "https://a.example/1" } });
    await refused(checkImageLink("https://a.example/1", loop), /couldn't open/);
  });

  it("refuses web pages, big files, errors and blocked addresses with plain messages", async () => {
    await refused(checkImageLink("https://photos.example/page", net({ "https://photos.example/page": { head: HTML, contentType: "text/html" } })), /doesn't lead straight to a picture/);
    await refused(checkImageLink("https://x.example/big.png", net({ "https://x.example/big.png": { head: PNG, length: 9e6 } })), /too large/);
    await refused(checkImageLink("https://x.example/404.png", net({ "https://x.example/404.png": { status: 404 } })), /couldn't open/);
    const blocked: Probe = async () => {
      throw Object.assign(new Error("blocked address"), { code: "EBLOCKED" });
    };
    await refused(checkImageLink("https://rebind.example/a.png", blocked), /isn't allowed/);
  });

  it("builds Markdown that a link or caption can't break out of", () => {
    expect(photoMarkdown("https://x.org/a (1).png", "A \\*nice\\* stew", "A [nice] stew")).toBe("![A nice stew](https://x.org/a%20%281%29.png)\n\nA \\*nice\\* stew");
    expect(photoMarkdown("https://x.org/a.png)<b>", "", "x")).toBe("![x](https://x.org/a.png%29%3Cb%3E)");
    expect(photoMarkdown("https://x.org/a.png", "", "")).toBe("![Recipe photo](https://x.org/a.png)");
  });
});

// ---------------------------------------------------------------------------
// Through the form
// ---------------------------------------------------------------------------

function setup() {
  const docs = booklet();
  const links = new MemoryPhotoLinks();
  const checked: string[] = [];
  const recipes = new RecipesService({
    docs,
    lock: new InMemoryLock(),
    slug: "fake",
    cacheMs: 0,
    photoLinks: links,
    checkLink: async (u) => {
      checked.push(u);
      if (u.includes("bad")) throw new ApiError("invalid", "That link doesn't lead straight to a picture.");
      return normaliseLink(u).href;
    },
  });
  const app = createApp({ recipes });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const { other: _o, photos: _p, ...base } = emptyForm();
  return { docs, links, checked, call, base };
}

describe("photos in the recipe form", () => {
  it("adds photos with captions at the end, records their links, and shows them back", async () => {
    const { docs, links, call, base } = setup();
    const s = docs.byTitle("Pasta Bake");
    const r = await call("PUT", `/api/recipes/${s.id}`, {
      baseRev: FakeDocs.rev(s),
      form: { ...base, headChef: "Mario", newPhotos: [{ url: "https://img.example.org/bake.jpg", caption: "Fresh *out* of the oven" }, { url: "https://img.example.org/2.png", caption: "" }] },
    });
    expect(r.status).toBe(200);
    expect(s.blocks.slice(-3)).toEqual(["\\[image\\]", "Fresh \\*out\\* of the oven", "\\[image\\]"]);
    expect(links.data[s.id]).toEqual(["https://img.example.org/bake.jpg", "https://img.example.org/2.png"]);

    const view = await call("GET", `/api/recipes/${s.id}`);
    expect(view.json.recipe.form).toMatchObject({
      editable: true,
      values: { headChef: "Mario", photos: [{ kind: "image", caption: "Fresh *out* of the oven", url: "https://img.example.org/bake.jpg" }, { kind: "image", caption: "", url: "https://img.example.org/2.png" }] },
    });
  });

  it("edits captions and text around photos without touching the pictures", async () => {
    const { docs, call, base } = setup();
    const s = docs.byTitle("Pasta Bake");
    await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, newPhotos: [{ url: "https://img.example.org/a.jpg", caption: "Old caption" }] } });
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, headChef: "New Chef", photos: [{ caption: "New caption" }] } });
    expect(r.status).toBe(200);
    expect(s.blocks[0]).toBe("**Head Chef: New Chef**");
    expect(s.blocks.slice(-2)).toEqual(["\\[image\\]", "New caption"]);
  });

  it("needs one caption per existing photo, so a stale page can't misplace them", async () => {
    const { docs, call, base } = setup();
    const s = docs.byTitle("Pasta Bake");
    await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, newPhotos: [{ url: "https://img.example.org/a.jpg", caption: "" }] } });
    const r = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, headChef: "X", photos: [] } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/photos in this recipe have changed/);
  });

  it("limits photos per save and per recipe, and reports which link failed", async () => {
    const { docs, call, base } = setup();
    const s = docs.byTitle("Pasta Bake");
    const four = Array.from({ length: 4 }, (_, i) => ({ url: `https://img.example.org/${i}.jpg`, caption: "" }));
    expect((await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, newPhotos: four } })).json.error.message).toMatch(/at most 3 photos at a time/);

    const bad = await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, newPhotos: [{ url: "https://img.example.org/ok.jpg", caption: "" }, { url: "https://img.example.org/bad", caption: "" }] } });
    expect(bad.json.error.message).toMatch(/^Photo 2: /);
    expect(s.blocks.some((b) => b.includes("image"))).toBe(false); // nothing written

    for (let round = 0; round < 2; round++) {
      const three = Array.from({ length: 3 }, (_, i) => ({ url: `https://img.example.org/r${round}-${i}.jpg`, caption: "" }));
      const cur = (await call("GET", `/api/recipes/${s.id}`)).json.recipe.form;
      expect((await call("PUT", `/api/recipes/${s.id}`, { baseRev: cur.rev, form: { ...base, photos: cur.values.photos.map(() => ({ caption: "" })), newPhotos: three } })).status).toBe(200);
    }
    const cur = (await call("GET", `/api/recipes/${s.id}`)).json.recipe.form;
    const seventh = await call("PUT", `/api/recipes/${s.id}`, { baseRev: cur.rev, form: { ...base, photos: cur.values.photos.map(() => ({ caption: "" })), newPhotos: [four[0]] } });
    expect(seventh.json.error.message).toMatch(/at most 6 photos \(it has 6 already\)/);
  });

  it("a new recipe can come with photos", async () => {
    const { docs, links, call, base } = setup();
    const r = await call("POST", "/api/recipes", { title: "Soup", form: { ...base, newPhotos: [{ url: "https://img.example.org/soup.jpg", caption: "Steaming" }] } });
    expect(r.status).toBe(201);
    const soup = docs.byTitle("Soup");
    expect(soup.blocks.slice(-2)).toEqual(["\\[image\\]", "Steaming"]);
    expect(links.data[soup.id]).toEqual(["https://img.example.org/soup.jpg"]);
  });

  it("a photo added by hand in docs.plus shows without a link; ours keep theirs", async () => {
    const { docs, call, base } = setup();
    const s = docs.byTitle("Pasta Bake");
    s.blocks.push("\\[image\\]", "Added by hand");
    await call("PUT", `/api/recipes/${s.id}`, { baseRev: FakeDocs.rev(s), form: { ...base, photos: [{ caption: "Added by hand" }], newPhotos: [{ url: "https://img.example.org/ours.jpg", caption: "Ours" }] } });
    const photos = (await call("GET", `/api/recipes/${s.id}`)).json.recipe.form.values.photos;
    expect(photos).toEqual([{ kind: "image", caption: "Added by hand" }, { kind: "image", caption: "Ours", url: "https://img.example.org/ours.jpg" }]);
  });

  it("long text under a picture makes the recipe organiser-only, as before", async () => {
    const { docs, call } = setup();
    const s = docs.byTitle("Pasta Bake");
    s.blocks.push("\\[image\\]", "Paragraph one.", "Paragraph two.");
    const r = await call("GET", `/api/recipes/${s.id}`);
    expect(r.json.recipe.form).toMatchObject({ editable: false, reason: expect.stringContaining("longer text under its pictures") });
  });
});

describe("photos with the approval queue", () => {
  it("queues photo links, checks them again on approval, then adds them", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { FilePendingQueue } = await import("../src/queue.js");
    const dir = await mkdtemp(path.join(tmpdir(), "photoq-"));
    try {
      const docs = booklet();
      const links = new MemoryPhotoLinks();
      let broken = false;
      const recipes = new RecipesService({
        docs, lock: new InMemoryLock(), slug: "fake", cacheMs: 0, photoLinks: links,
        checkLink: async (u) => {
          if (broken) throw new ApiError("invalid", "We couldn't open that photo link.");
          return u;
        },
      });
      const TOKEN = "k".repeat(40);
      const app = createApp({ recipes, queue: new FilePendingQueue(dir), adminToken: TOKEN });
      const req = async (method: string, url: string, body?: unknown) => {
        const res = await app.request(url, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as any };
      };
      const { other: _o, photos: _p, ...base } = emptyForm();
      const s = docs.byTitle("Pasta Bake");
      const before = [...s.blocks];

      // Photos alone count as a change worth queueing.
      const cur = (await req("GET", `/api/recipes/${s.id}`)).json.recipe.form;
      const values = { ...base, headChef: cur.values.headChef, helpers: cur.values.helpers, date: cur.values.date };
      const q = await req("PUT", `/api/recipes/${s.id}`, { baseRev: cur.rev, form: { ...values, newPhotos: [{ url: "https://img.example.org/q.jpg", caption: "Queued" }] } });
      expect(q.status).toBe(202);
      expect(s.blocks).toEqual(before);
      expect((await req("GET", `/api/admin/pending/${q.json.pending.id}`)).json.pending.photos).toEqual([{ url: "https://img.example.org/q.jpg", caption: "Queued" }]);

      // The link broke while it waited: approval refuses, the item stays.
      broken = true;
      expect((await req("POST", `/api/admin/pending/${q.json.pending.id}/approve`, {})).status).toBe(422);
      broken = false;
      expect((await req("POST", `/api/admin/pending/${q.json.pending.id}/approve`, {})).status).toBe(200);
      expect(s.blocks.slice(-2)).toEqual(["\\[image\\]", "Queued"]);
      expect(links.data[s.id]).toEqual(["https://img.example.org/q.jpg"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
