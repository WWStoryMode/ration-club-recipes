/**
 * Serialises writes per document so two saves can't interleave their read → edit → re-read steps.
 * InMemoryLock covers one always-on server. RedisLock (concurrency phase) covers serverless.
 */
export interface Lock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export class InMemoryLock implements Lock {
  private tails = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run after the previous holder, whether it succeeded or not
    const tail = run.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
