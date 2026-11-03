import { createHmac, randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AuditOutcome = "saved" | "unchanged" | "added" | "conflict" | "refused" | "blocked" | "failed";

/** One line per write attempt. Never holds a raw IP: only a salted hash, so repeat sources can be spotted, not identified. */
export interface AuditEntry {
  ts: string;
  requestId: string;
  action: "save_section" | "add_recipe";
  outcome: AuditOutcome;
  reason?: string;
  ipHash: string;
  recipeId?: string;
  recipe?: string; // title
  sectionId?: string;
  baseRev?: string;
  newRev?: string;
  before?: string[]; // text parts before the write
  after?: string[]; // text parts after the write
  attempted?: string[]; // what the visitor sent, when it wasn't written (truncated)
}

export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
}

export const noAudit: AuditLog = { write: async () => {} };

/**
 * Append-only JSON Lines, one file per UTC day: DATA_DIR/audit-YYYY-MM-DD.jsonl. Nothing is ever rewritten.
 * DATA_DIR must be on the persistent disk in production.
 */
export class FileAuditLog implements AuditLog {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  static fileFor(dir: string, ts: string) {
    return path.join(dir, `audit-${ts.slice(0, 10)}.jsonl`);
  }

  async write(entry: AuditEntry): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => chmod(this.dir, 0o700));
    await this.ready;
    await appendFile(FileAuditLog.fileFor(this.dir, entry.ts), JSON.stringify(entry) + "\n", { mode: 0o600 });
  }
}

/** HMAC-SHA256(salt, ip), first 16 hex chars. Same IP → same hash; the IP can't be recovered without the salt. */
export function ipHasher(salt: string) {
  return (ip: string) => createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16);
}

/** AUDIT_SALT if set; otherwise a random salt kept in DATA_DIR/audit-salt (created once, mode 0600). */
export async function loadSalt(dir: string, envSalt?: string): Promise<string> {
  if (envSalt?.trim()) return envSalt.trim();
  const file = path.join(dir, "audit-salt");
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const salt = randomBytes(32).toString("hex");
  await writeFile(file, salt + "\n", { mode: 0o600, flag: "wx" }).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  return (await readFile(file, "utf8")).trim();
}

export const truncate = (texts: string[] | undefined, max = 2000) => texts?.map((t) => (t.length > max ? `${t.slice(0, max)}…[+${t.length - max}]` : t));
