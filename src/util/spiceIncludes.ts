import path from "node:path";
import fs from "fs-extra";

export type BundledInclude = {
  directive: "include" | "lib";
  originalSpecifier: string;
  resolvedSourcePath: string;
  destPath: string;
};

export type BundleIncludesResult = {
  bundledNetlist: string;
  copied: BundledInclude[];
  missing: Array<{ directive: "include" | "lib"; originalSpecifier: string; resolvedAttemptPath: string }>;
  includesDir: string;
};

const COMMENT_RE = /^\s*[\*;]/;

function stripQuotes(s: string): { value: string; quote: "\"" | "'" | "" } {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("\"") && t.endsWith("\"")) return { value: t.slice(1, -1), quote: "\"" };
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return { value: t.slice(1, -1), quote: "'" };
  return { value: t, quote: "" };
}

function parseDirectiveLine(
  line: string,
):
  | {
      directive: "include" | "lib";
      fileToken: string;
      filePath: string;
      quote: "\"" | "'" | "";
    }
  | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (COMMENT_RE.test(trimmed)) return undefined;

  // Normalize tabs/spaces
  const m = trimmed.match(/^\.(include|lib)\s+(.+?)\s*$/i);
  if (!m) return undefined;

  const directive = m[1].toLowerCase() as "include" | "lib";
  const rest = m[2].trim();
  if (!rest) return undefined;

  // First argument is the filename (possibly quoted). For .lib, the second token might be a section name; we ignore it.
  // Supported forms:
  //   .include foo.lib
  //   .include "foo.lib"
  //   .lib mymodels.lib
  //   .lib "mymodels.lib" TT
  let fileToken = "";
  if (rest.startsWith("\"")) {
    const j = rest.indexOf("\"", 1);
    if (j > 0) fileToken = rest.slice(0, j + 1);
  } else if (rest.startsWith("'")) {
    const j = rest.indexOf("'", 1);
    if (j > 0) fileToken = rest.slice(0, j + 1);
  } else {
    fileToken = rest.split(/\s+/)[0];
  }

  if (!fileToken) return undefined;
  const { value: filePath, quote } = stripQuotes(fileToken);
  if (!filePath) return undefined;

  return { directive, fileToken, filePath, quote };
}

function normalizeDestRelPath(rel: string): string {
  // Avoid escaping out of includes directory and normalize separators.
  const parts = rel
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/[:*?"<>|]/g, "_"));
  return parts.join(path.sep);
}

function posixify(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function bundleSpiceIncludes(args: {
  netlistText: string;
  baselineFilePath: string;
  runDir: string;
  includesDirName?: string;
  maxFiles?: number;
  maxTotalBytes?: number;
}): Promise<BundleIncludesResult> {
  const includesDirName = args.includesDirName ?? "includes";
  const includesDir = path.join(args.runDir, includesDirName);
  await fs.mkdirp(includesDir);

  const baseDir = path.dirname(args.baselineFilePath);
  const lines = args.netlistText.split(/\r?\n/);

  const maxFiles = args.maxFiles ?? 200;
  const maxTotalBytes = args.maxTotalBytes ?? 20_000_000;

  const copied: BundledInclude[] = [];
  const missing: Array<{ directive: "include" | "lib"; originalSpecifier: string; resolvedAttemptPath: string }> = [];

  const rewriteMap = new Map<string, string>();

  let totalBytes = 0;

  for (const line of lines) {
    const info = parseDirectiveLine(line);
    if (!info) continue;

    const originalSpecifier = info.filePath;

    // If the specifier looks like a library name without extension, we still try to resolve as a path.
    const resolvedAttemptPath = path.isAbsolute(originalSpecifier)
      ? originalSpecifier
      : path.resolve(baseDir, originalSpecifier);

    if (rewriteMap.has(originalSpecifier)) continue;

    const exists = await fs.pathExists(resolvedAttemptPath);
    if (!exists) {
      missing.push({ directive: info.directive, originalSpecifier, resolvedAttemptPath });
      continue;
    }

    if (copied.length >= maxFiles) {
      break;
    }

    const stat = await fs.stat(resolvedAttemptPath);
    if (totalBytes + stat.size > maxTotalBytes) {
      break;
    }

    let destRel: string;
    if (path.isAbsolute(originalSpecifier)) {
      // Store absolute includes under includes/abs/<safe basename>_<hash>.<ext>
      const base = path.basename(resolvedAttemptPath);
      const hash = Buffer.from(resolvedAttemptPath).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
      destRel = normalizeDestRelPath(path.join("abs", `${base}_${hash}`));
    } else {
      // Preserve relative structure under includes/
      const rel = path.relative(baseDir, resolvedAttemptPath);
      destRel = normalizeDestRelPath(rel);
    }

    const destPath = path.join(includesDir, destRel);
    await fs.mkdirp(path.dirname(destPath));
    await fs.copy(resolvedAttemptPath, destPath);

    totalBytes += stat.size;

    // Rewrite to a path relative to runDir
    const rewritten = posixify(path.relative(args.runDir, destPath));
    rewriteMap.set(originalSpecifier, rewritten);

    copied.push({
      directive: info.directive,
      originalSpecifier,
      resolvedSourcePath: resolvedAttemptPath,
      destPath,
    });
  }

  const bundledNetlist = lines
    .map((line) => {
      const info = parseDirectiveLine(line);
      if (!info) return line;
      const rewritten = rewriteMap.get(info.filePath);
      if (!rewritten) return line;
      const q = info.quote;
      const repl = q ? `${q}${rewritten}${q}` : rewritten;
      // Replace only the first occurrence of the file token.
      return line.replace(info.fileToken, repl);
    })
    .join("\n");

  return { bundledNetlist, copied, missing, includesDir };
}
