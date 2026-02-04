import path from "node:path";
import { mkdirp } from "fs-extra";

export async function makeRunDir(baseDir = "runs"): Promise<string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dirName =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const full = path.join(baseDir, dirName);
  await mkdirp(full);
  return full;
}
