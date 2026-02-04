import fs from "fs-extra";

export async function readTextIfExists(filePath?: string): Promise<string | undefined> {
  if (!filePath) return undefined;
  const ok = await fs.pathExists(filePath);
  if (!ok) return undefined;
  return fs.readFile(filePath, "utf-8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await fs.outputFile(filePath, content, "utf-8");
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.outputJson(filePath, data, { spaces: 2 });
}
