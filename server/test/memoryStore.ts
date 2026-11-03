import type { AuthKey, AuthRecords, TokenStore } from "../src/auth/TokenStore.js";

export class MemoryStore implements TokenStore {
  data = new Map<AuthKey, unknown>();
  async get<K extends AuthKey>(k: K) {
    return this.data.get(k) as AuthRecords[K] | undefined;
  }
  async set<K extends AuthKey>(k: K, v: AuthRecords[K]) {
    this.data.set(k, structuredClone(v));
  }
  async delete(...keys: AuthKey[]) {
    for (const k of keys) this.data.delete(k);
  }
}
