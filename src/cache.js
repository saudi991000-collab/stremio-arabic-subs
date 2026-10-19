import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class Cache {
  constructor(directory, ttlSeconds) {
    this.directory = directory;
    this.ttlMs = ttlSeconds * 1000;
    this.memory = new Map();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
  }

  getMemory(key) {
    const value = this.memory.get(key);
    if (!value || value.expires < Date.now()) {
      this.memory.delete(key);
      return undefined;
    }
    return value.data;
  }

  setMemory(key, data) {
    this.memory.set(key, { expires: Date.now() + this.ttlMs, data });
  }

  filePath(key) {
    return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.cache`);
  }

  async getFile(key) {
    try {
      return await readFile(this.filePath(key));
    } catch {
      return undefined;
    }
  }

  async setFile(key, data) {
    await writeFile(this.filePath(key), data, { flag: "wx" }).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}
