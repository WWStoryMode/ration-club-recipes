/**
 * The approval queue, for organisers. Talks to the server's admin API, so it works against a hosted server too.
 *
 *   pnpm queue                          list waiting changes
 *   pnpm queue show <id>                one change: the text now, and the proposed text
 *   pnpm queue approve <id> [--overwrite]   write it to the document (--overwrite: even if the section changed since)
 *   pnpm queue reject <id> [--note "why"]
 *
 * <id> can be the first 8+ characters. Needs ADMIN_TOKEN, and API_URL for a hosted server (default http://localhost:PORT).
 */
import type { PendingChange } from "../queue.js";

const base = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, "");
const token = process.env.ADMIN_TOKEN?.trim();

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(`${res.status}: ${json.error?.message ?? res.statusText}`);
  return json;
}

const label = (p: PendingChange) =>
  (p.kind === "save_section" ? `edit  "${p.recipe}"${p.section !== p.recipe ? ` › ${p.section}` : ""}` : `new   "${p.title}"`) +
  (p.photos?.length ? `  +${p.photos.length} photo(s)` : "");

async function resolve(prefix: string | undefined): Promise<string> {
  if (!prefix || prefix.length < 8) throw new Error("Give the change's id (at least its first 8 characters). Run `pnpm queue` to list them.");
  const { pending } = await api<{ pending: PendingChange[] }>("GET", "/pending");
  const hits = pending.filter((p) => p.id.startsWith(prefix.toLowerCase()));
  if (hits.length !== 1) throw new Error(hits.length ? `"${prefix}" matches ${hits.length} changes; give more characters.` : `No waiting change starts with "${prefix}".`);
  return hits[0]!.id;
}

/** New photos can never be removed by the app afterwards: open each link and look before approving. */
const photos = (list: Array<{ url: string; caption: string }> | undefined) => {
  if (!list?.length) return;
  console.log(`\n--- ${list.length} new photo(s): open each link and look before approving ---`);
  list.forEach((x, i) => console.log(`${i + 1}. ${x.url}${x.caption ? `\n   caption: ${x.caption}` : ""}`));
};

const block = (title: string, parts: string[]) => {
  console.log(`\n--- ${title} ---`);
  parts.forEach((t, i) => console.log(`${parts.length > 1 ? `[part ${i + 1}]\n` : ""}${t || "(empty)"}`));
};

async function main() {
  if (!token) throw new Error("Set ADMIN_TOKEN (the same value as on the server).");
  const [cmd = "list", id] = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] === "--note"));

  if (cmd === "list") {
    const { pending } = await api<{ pending: PendingChange[] }>("GET", "/pending");
    if (!pending.length) return console.log("Nothing is waiting for approval.");
    for (const p of pending) console.log(`${p.id.slice(0, 8)}  ${p.submittedAt.slice(0, 16).replace("T", " ")}  ${label(p)}  ip#${p.ipHash}`);
    return console.log(`\n${pending.length} waiting. \`pnpm queue show <id>\` to read one.`);
  }

  const full = await resolve(id);
  if (cmd === "show") {
    const r = await api<{ pending: PendingChange; current?: string[]; changedSince?: boolean }>("GET", `/pending/${full}`);
    const p = r.pending;
    console.log(`${p.id}\n${label(p)}\nsubmitted ${p.submittedAt} from ip#${p.ipHash}`);
    if (p.kind === "save_section") {
      block("in the document now", r.current ?? []);
      block("proposed", p.texts);
      photos(p.photos);
      if (r.changedSince) console.log("\n! The section changed after the visitor loaded it. Approving needs --overwrite, which replaces the newer text.");
    } else {
      block("proposed recipe", [p.markdown || "(empty: the standard Head Chef / Support / Ingredients / Method template)"]);
      photos(p.photos);
    }
    return;
  }
  if (cmd === "approve") {
    await api("POST", `/pending/${full}/approve`, { overwrite: flag("--overwrite") });
    return console.log(`Approved ${full.slice(0, 8)}: it's in the document now.`);
  }
  if (cmd === "reject") {
    await api("POST", `/pending/${full}/reject`, { note: opt("--note") });
    return console.log(`Rejected ${full.slice(0, 8)}.`);
  }
  throw new Error(`Unknown command "${cmd}". Use list, show, approve or reject.`);
}

main().catch((err) => {
  console.error(`queue: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
