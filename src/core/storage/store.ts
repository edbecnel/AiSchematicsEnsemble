/**
 * Phase 4.5 — Storage backend abstraction
 *
 * The StorageBackend interface hides whether data is written to the local
 * filesystem (local/dev mode) or to object storage (hosted mode).
 * All run orchestration code uses this interface — never fs-extra directly.
 *
 * Current implementations:
 *  - LocalFsStorageBackend  (src/core/storage/store.ts — this file)
 *
 * Future implementations (not yet written):
 *  - S3StorageBackend
 *  - GcsStorageBackend
 *  - InMemoryStorageBackend (for tests)
 */

import path from "node:path";
import fs from "fs-extra";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  /**
   * Write arbitrary JSON data under the given key.
   * Creates intermediate directories automatically.
   */
  writeJson(key: string, data: unknown): Promise<void>;

  /**
   * Write raw text under the given key.
   * Creates intermediate directories automatically.
   */
  writeText(key: string, content: string): Promise<void>;

  /**
   * Write raw binary data under the given key.
   * Creates intermediate directories automatically.
   */
  writeBytes(key: string, data: Buffer): Promise<void>;

  /**
   * Read JSON data from the given key.
   * Returns `undefined` if the key does not exist.
   */
  readJson<T = unknown>(key: string): Promise<T | undefined>;

  /**
   * Read raw text from the given key.
   * Returns `undefined` if the key does not exist.
   */
  readText(key: string): Promise<string | undefined>;

  /**
   * Return true if the given key exists.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Delete the given key.  No-op if it does not exist.
   */
  delete(key: string): Promise<void>;

  /**
   * List all keys under a given prefix (non-recursive by default).
   * Returns relative key strings (not absolute paths).
   * Pass `recursive: true` to include all descendants.
   */
  list(prefix: string, options?: { recursive?: boolean }): Promise<string[]>;

  /**
   * Resolve a storage key to a human-readable location string (absolute path
   * for local FS, full URL or key string for object storage).
   * Useful for logging and report output references.
   */
  resolveLocation(key: string): string;
}

// ---------------------------------------------------------------------------
// LocalFsStorageBackend
// ---------------------------------------------------------------------------

/**
 * Filesystem-backed storage backend.  `baseDir` is an absolute path that
 * acts as the root; all keys are resolved relative to it.
 *
 * Example:
 *   const store = new LocalFsStorageBackend("/home/user/runs/20260315_120000");
 *   await store.writeJson("run.json", runRecord);
 *   // writes to /home/user/runs/20260315_120000/run.json
 *
 * For backwards compatibility with the legacy run-dir layout, set `baseDir`
 * to the run directory produced by makeRunDir().
 */
export class LocalFsStorageBackend implements StorageBackend {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    // Prevent path traversal: strip leading slashes and collapse ../
    const safe = path.normalize(key).replace(/^(\.\.[\\/])+/, "");
    return path.join(this.baseDir, safe);
  }

  async writeJson(key: string, data: unknown): Promise<void> {
    await fs.outputJson(this.resolve(key), data, { spaces: 2 });
  }

  async writeText(key: string, content: string): Promise<void> {
    await fs.outputFile(this.resolve(key), content, "utf-8");
  }

  async writeBytes(key: string, data: Buffer): Promise<void> {
    const dest = this.resolve(key);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, data);
  }

  async readJson<T = unknown>(key: string): Promise<T | undefined> {
    const p = this.resolve(key);
    if (!(await fs.pathExists(p))) return undefined;
    return fs.readJson(p) as Promise<T>;
  }

  async readText(key: string): Promise<string | undefined> {
    const p = this.resolve(key);
    if (!(await fs.pathExists(p))) return undefined;
    return fs.readFile(p, "utf-8");
  }

  async exists(key: string): Promise<boolean> {
    return fs.pathExists(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    const p = this.resolve(key);
    if (await fs.pathExists(p)) {
      await fs.remove(p);
    }
  }

  async list(prefix: string, options?: { recursive?: boolean }): Promise<string[]> {
    const dir = this.resolve(prefix);
    if (!(await fs.pathExists(dir))) return [];

    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return [prefix];

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const rel = path.join(prefix, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (options?.recursive) {
          const children = await this.list(rel, options);
          results.push(...children);
        }
      } else {
        results.push(rel);
      }
    }

    return results;
  }

  resolveLocation(key: string): string {
    return this.resolve(key);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a LocalFsStorageBackend rooted at the given run directory.
 * This is the primary factory used in local/dev mode.
 */
export function createLocalStorage(runDir: string): LocalFsStorageBackend {
  return new LocalFsStorageBackend(path.resolve(runDir));
}
