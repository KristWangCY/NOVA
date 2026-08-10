import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`node home contains an invalid lock file: ${path}`);
  }
}

export class NodeHomeLock {
  constructor(home) {
    this.path = resolve(home, "node.lock");
    this.instanceId = randomUUID();
    this.released = false;
    this.owner = {
      version: 1,
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: Date.now(),
    };
    this.acquire();
    this.exitHandler = () => this.release();
    process.once("exit", this.exitHandler);
  }

  acquire(retried = false) {
    let descriptor;
    try {
      descriptor = openSync(this.path, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(this.owner, null, 2)}\n`, "utf8");
      closeSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* already closed */ }
      }
      if (error?.code !== "EEXIST" || retried) throw error;
      const existing = readOwner(this.path);
      if (processIsAlive(existing.pid)) {
        throw new Error(`node home is already in use by process ${existing.pid}`);
      }
      unlinkSync(this.path);
      this.acquire(true);
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    process.removeListener("exit", this.exitHandler);
    try {
      const existing = readOwner(this.path);
      if (existing.instanceId === this.instanceId) {
        unlinkSync(this.path);
      }
    } catch {
      // Never remove a lock we cannot prove belongs to this instance.
    }
  }
}
