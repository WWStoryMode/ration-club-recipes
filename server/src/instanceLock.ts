import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockInfo {
  id: string;
  host: string;
  pid: number;
  beat: number; // epoch ms of the last heartbeat
}

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LockInfo;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** True if another live server holds the lock (heartbeat newer than staleMs). */
export async function serverLockHeld(file: string, staleMs = 90_000, now = Date.now()): Promise<LockInfo | undefined> {
  const info = await readLock(file);
  return info && now - info.beat < staleMs ? info : undefined;
}

/**
 * Makes sure only ONE server uses a login at a time. Two servers sharing the rotating refresh token would
 * spend each other's tokens and break the login. The lock lives next to the tokens (SECRETS_DIR), with a heartbeat;
 * a lock whose heartbeat is older than staleMs (e.g. after a crash) is taken over.
 */
export class InstanceLock {
  readonly id = randomBytes(8).toString("hex");
  private timer?: NodeJS.Timeout;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly file: string,
    private readonly opts: { staleMs?: number; beatMs?: number; now?: () => number; onLost?: (by?: LockInfo) => void } = {},
  ) {
    this.staleMs = opts.staleMs ?? 90_000;
    this.now = opts.now ?? Date.now;
  }

  private info(): LockInfo {
    return { id: this.id, host: hostname(), pid: process.pid, beat: this.now() };
  }

  private async write() {
    const tmp = `${this.file}.${this.id}.tmp`;
    await writeFile(tmp, JSON.stringify(this.info()), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async acquire(): Promise<void> {
    const other = await readLock(this.file);
    if (other && other.id !== this.id) {
      const age = this.now() - other.beat;
      if (age < this.staleMs) {
        throw new InstanceLockError(
          `Another server (host ${other.host}, pid ${other.pid}, last seen ${Math.round(age / 1000)} s ago) is using this docs.plus login. ` +
            `Only one may run at a time. Stop it, or wait ${Math.ceil((this.staleMs - age) / 1000)} s if it has crashed.`,
        );
      }
      console.warn(`[lock] taking over a stale lock from host ${other.host}, pid ${other.pid}`);
    }
    if (!other) {
      // Create exclusively, so two servers starting at once can't both win.
      try {
        await writeFile(this.file, JSON.stringify(this.info()), { mode: 0o600, flag: "wx" });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return this.acquire();
        throw err;
      }
    }
    await this.write();
  }

  /** Refresh the heartbeat. If someone else has taken the lock, call onLost instead. */
  async beat(): Promise<void> {
    const cur = await readLock(this.file);
    if (cur?.id !== this.id) {
      this.stopHeartbeat();
      this.opts.onLost?.(cur);
      return;
    }
    await this.write();
  }

  startHeartbeat() {
    this.timer = setInterval(() => void this.beat().catch((e) => console.error("[lock] heartbeat failed:", e)), this.opts.beatMs ?? 30_000);
    this.timer.unref();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if ((await readLock(this.file))?.id === this.id) await rm(this.file, { force: true });
  }
}
