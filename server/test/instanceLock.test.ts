import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InstanceLock, InstanceLockError, readLock, serverLockHeld } from "../src/instanceLock.js";

async function lockFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), "rcr-lock-")), "server.lock");
}

describe("InstanceLock", () => {
  it("refuses a second server while the first is alive", async () => {
    const file = await lockFile();
    let t = 1_000_000;
    const a = new InstanceLock(file, { now: () => t });
    await a.acquire();
    const b = new InstanceLock(file, { now: () => t });
    t += 60_000;
    await expect(b.acquire()).rejects.toBeInstanceOf(InstanceLockError);
    await expect(b.acquire()).rejects.toThrow(/Only one may run at a time/);
  });

  it("takes over a stale lock (crashed server)", async () => {
    const file = await lockFile();
    let t = 1_000_000;
    await new InstanceLock(file, { now: () => t }).acquire();
    t += 91_000;
    const b = new InstanceLock(file, { now: () => t });
    await b.acquire();
    expect((await readLock(file))?.id).toBe(b.id);
  });

  it("heartbeat keeps it fresh; release removes it", async () => {
    const file = await lockFile();
    let t = 1_000_000;
    const a = new InstanceLock(file, { now: () => t });
    await a.acquire();
    t += 80_000;
    await a.beat();
    t += 80_000; // 160 s after start, 80 s after the beat: still held
    expect(await serverLockHeld(file, 90_000, t)).toMatchObject({ id: a.id });
    await a.release();
    await expect(readFile(file)).rejects.toThrow();
  });

  it("notices when another server took over", async () => {
    const file = await lockFile();
    let lostTo: string | undefined;
    const a = new InstanceLock(file, { onLost: (by) => (lostTo = by?.id) });
    await a.acquire();
    await writeFile(file, JSON.stringify({ id: "intruder", host: "h", pid: 1, beat: Date.now() }));
    await a.beat();
    expect(lostTo).toBe("intruder");
    await a.release(); // must not delete the other server's lock
    expect((await readLock(file))?.id).toBe("intruder");
  });

  it("only one of two servers starting at the same time wins", async () => {
    const file = await lockFile();
    const results = await Promise.allSettled([new InstanceLock(file).acquire(), new InstanceLock(file).acquire()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
