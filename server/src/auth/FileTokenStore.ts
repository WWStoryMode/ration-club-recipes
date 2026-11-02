import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AuthKey, AuthRecords, TokenStore } from "./TokenStore.js";

/**
 * Local-dev token store: one JSON file per key in a gitignored directory (default .secrets/).
 * The directory is 0700 and files are 0600. Writes go to a temp file first, then rename, so a crash never leaves a half-written token.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly dir: string) {}

  private file(key: AuthKey) {
    return path.join(this.dir, `${key}.json`);
  }

  async get<K extends AuthKey>(key: K): Promise<AuthRecords[K] | undefined> {
    try {
      return JSON.parse(await readFile(this.file(key), "utf8")) as AuthRecords[K];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async set<K extends AuthKey>(key: K, value: AuthRecords[K]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = `${this.file(key)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, this.file(key));
  }

  async delete(...keys: AuthKey[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.file(k), { force: true })));
  }
}
