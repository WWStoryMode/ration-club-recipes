import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./errors.js";
import { InMemoryLock } from "./lock.js";

/**
 * Approval queue (REQUIRE_APPROVAL=1): visitors' changes wait here until an organiser approves or rejects them.
 * Nothing reaches docs.plus until then. Items hold the visitor's text (already cleaned) and an IP hash, never an IP.
 */

interface Base {
  id: string;
  submittedAt: string;
  requestId: string;
  ipHash: string;
}
export interface PendingSection extends Base {
  kind: "save_section";
  sectionId: string;
  section: string; // title of the section, for display
  recipeId: string;
  recipe: string;
  baseRev: string;
  before: string[];
  texts: string[];
}
export interface PendingRecipe extends Base {
  kind: "add_recipe";
  title: string;
  markdown: string;
}
export type PendingChange = PendingSection | PendingRecipe;
export type NewPending = Omit<PendingSection, "id" | "submittedAt"> | Omit<PendingRecipe, "id" | "submittedAt">;

export interface PendingQueue {
  add(item: NewPending): Promise<PendingChange>;
  list(): Promise<PendingChange[]>; // oldest first
  get(id: string): Promise<PendingChange | undefined>;
  remove(id: string): Promise<void>;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isPendingId = (id: string) => ID.test(id);

export const QUEUE_MESSAGES = {
  full: "Lots of changes are waiting to be checked right now. Please try again later.",
  perVisitor: (n: number) => `You already have ${n} changes waiting to be checked. Please wait until an organiser has looked at them.`,
};

/**
 * One JSON file per item in DATA_DIR/pending (mode 0600). A decision deletes the file; the audit log keeps the record.
 * Limits stop a flood from filling the disk: `max` items in total and `perIp` per IP hash.
 */
export class FilePendingQueue implements PendingQueue {
  private readonly lock = new InMemoryLock();
  private ready?: Promise<void>;

  constructor(
    private readonly dir: string,
    private readonly opts: { max?: number; perIp?: number; now?: () => Date } = {},
  ) {}

  private file(id: string) {
    if (!isPendingId(id)) throw new ApiError("not_found", "No such pending change.");
    return path.join(this.dir, `${id}.json`);
  }

  private async init() {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => chmod(this.dir, 0o700));
    await this.ready;
  }

  add(item: NewPending): Promise<PendingChange> {
    return this.lock.withLock("queue", async () => {
      const all = await this.list();
      if (all.length >= (this.opts.max ?? 200)) throw new ApiError("rate_limited", QUEUE_MESSAGES.full, { reason: "queue_full" });
      const perIp = this.opts.perIp ?? 10;
      if (all.filter((x) => x.ipHash === item.ipHash).length >= perIp) {
        throw new ApiError("rate_limited", QUEUE_MESSAGES.perVisitor(perIp), { reason: "queue_per_ip" });
      }
      const full = { ...item, id: randomUUID(), submittedAt: (this.opts.now?.() ?? new Date()).toISOString() } as PendingChange;
      const tmp = `${this.file(full.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
      await rename(tmp, this.file(full.id));
      return full;
    });
  }

  async list(): Promise<PendingChange[]> {
    await this.init();
    const names = (await readdir(this.dir)).filter((f) => f.endsWith(".json") && isPendingId(f.slice(0, -5)));
    const items = await Promise.all(names.map((f) => this.get(f.slice(0, -5))));
    return items.filter((x): x is PendingChange => !!x).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  async get(id: string): Promise<PendingChange | undefined> {
    if (!isPendingId(id)) return undefined;
    await this.init();
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as PendingChange;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
