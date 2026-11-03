/**
 * pnpm audit-log [-- --tail 20] [--full] [--day 2026-11-03]: read the audit log in DATA_DIR.
 * One line per write attempt: time, outcome, action, recipe, IP hash, reason. --full prints whole entries (with text).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { AuditEntry } from "../protect/audit.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const files = (await readdir(config.dataDir).catch(() => [] as string[])).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const day = arg("--day");
  const chosen = day ? files.filter((f) => f.includes(day)) : files;
  if (!chosen.length) return console.log(`No audit entries in ${config.dataDir}${day ? ` for ${day}` : ""}.`);

  const lines = (await Promise.all(chosen.map((f) => readFile(path.join(config.dataDir, f), "utf8")))).join("").split("\n").filter(Boolean);
  const tail = Number(arg("--tail") ?? 20);
  for (const line of lines.slice(-tail)) {
    const e = JSON.parse(line) as AuditEntry;
    if (process.argv.includes("--full")) {
      console.log(JSON.stringify(e, null, 2));
      continue;
    }
    const what = e.recipe ? `"${e.recipe}"` : e.sectionId ?? "";
    console.log(`${e.ts}  ${e.outcome.padEnd(9)} ${e.action.padEnd(12)} ${what.padEnd(28)} ip#${e.ipHash}${e.pendingId ? `  pending#${e.pendingId.slice(0, 8)}` : ""}${e.reason ? `  (${e.reason})` : ""}${e.note ? `  note: ${e.note}` : ""}`);
  }
  console.log(`\n${Math.min(tail, lines.length)} of ${lines.length} entries from ${chosen.length} day(s) in ${config.dataDir}`);
}

main().catch((err) => {
  console.error(`audit-log failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
