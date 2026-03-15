/**
 * SUBCKT utility run directory management.
 * Mirrors the pattern from src/util/runDir.ts but uses a dedicated
 * root (subckt_runs/) and includes the component name in the directory name.
 */

import path from "node:path";
import { mkdirp } from "fs-extra";

/**
 * Create a timestamped SUBCKT utility run directory.
 * Format: `{baseDir}/{YYYYMMDD_HHMMSS}_{componentSlug}/`
 */
export async function makeSubcktRunDir(
  componentName: string,
  baseDir = "subckt_runs",
): Promise<string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const slug = componentName
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 32)
    .replace(/^_+|_+$/g, "");

  const dirName = `${ts}_${slug || "component"}`;
  const full = path.join(baseDir, dirName);
  await mkdirp(full);
  return full;
}
