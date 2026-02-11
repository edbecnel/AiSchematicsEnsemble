import http from "node:http";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import { execa } from "execa";
import Busboy from "busboy";
import archiver from "archiver";

import { runBatch, type RunBatchOptions, type RunBatchResult, type RunBatchLogger } from "../runBatch.js";

export type UiServerOptions = {
  host?: string;
  port?: number;
  /** Output root for runs; forwarded as default in the UI. */
  outdir?: string;
  /** Auto-open browser after start when supported. */
  openBrowser?: boolean;
};

type Json = Record<string, any>;

async function spawnDetached(command: string, args: string[]): Promise<void> {
  // Use detached + ignore stdio so the UI request can return immediately.
  // This tends to be more reliable for GUI apps on Windows than awaiting a child process.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    // If spawn succeeds, we can resolve almost immediately.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 50);

    child.unref();
  });
}

function sendJson(res: http.ServerResponse, status: number, data: Json): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

type EnvKeyName = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "XAI_API_KEY";

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2] ?? "";
    // Strip surrounding quotes if present
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function formatEnvValue(v: string): string {
  // API keys are typically safe unquoted, but be conservative.
  if (!v) return "";
  if (/^[A-Za-z0-9_\-\.]+$/.test(v)) return v;
  return '"' + v.replace(/"/g, '\\"') + '"';
}

function upsertEnvLines(existingText: string, updates: Partial<Record<EnvKeyName, string | undefined>>): string {
  const lines = existingText.split(/\r?\n/);
  const seen = new Set<EnvKeyName>();

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/);
    const key = (m?.[1] as EnvKeyName | undefined) ?? undefined;
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      const nextVal = updates[key];
      if (typeof nextVal === "string" && nextVal.trim()) {
        out.push(`${key}=${formatEnvValue(nextVal.trim())}`);
      } else {
        // delete by omission
      }
      continue;
    }
    out.push(line);
  }

  // Append missing keys at end
  for (const k of Object.keys(updates) as EnvKeyName[]) {
    if (seen.has(k)) continue;
    const v = updates[k];
    if (typeof v === "string" && v.trim()) out.push(`${k}=${formatEnvValue(v.trim())}`);
  }

  // Normalize trailing newline
  let joined = out.join("\n");
  if (!joined.endsWith("\n")) joined += "\n";
  return joined;
}

async function ensureEnvBackup(opts: { cwd: string; maxBackups: number }): Promise<{ backupPath?: string }> {
  const envPath = path.resolve(opts.cwd, ".env");
  const exists = await fs.pathExists(envPath);
  if (!exists) return {};

  const backupsDir = path.resolve(opts.cwd, ".env_backups");
  await fs.mkdirp(backupsDir);
  const stamp = new Date();
  const yyyy = String(stamp.getFullYear());
  const mm = String(stamp.getMonth() + 1).padStart(2, "0");
  const dd = String(stamp.getDate()).padStart(2, "0");
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mi = String(stamp.getMinutes()).padStart(2, "0");
  const ss = String(stamp.getSeconds()).padStart(2, "0");
  const ms = String(stamp.getMilliseconds()).padStart(3, "0");
  const rand = crypto.randomUUID().slice(0, 8);
  const backupName = `.env.${yyyy}${mm}${dd}_${hh}${mi}${ss}_${ms}.${rand}.bak`;
  const backupPath = path.join(backupsDir, backupName);
  await fs.copy(envPath, backupPath);

  // Prune old backups (best-effort)
  try {
    const entries = (await fs.readdir(backupsDir)).filter((n) => n.startsWith(".env.") && n.endsWith(".bak"));
    const full = await Promise.all(
      entries.map(async (n) => ({
        name: n,
        p: path.join(backupsDir, n),
        stat: await fs.stat(path.join(backupsDir, n)),
      })),
    );
    full.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const toDelete = full.slice(opts.maxBackups);
    for (const d of toDelete) {
      await fs.remove(d.p);
    }
  } catch {
    // ignore
  }

  return { backupPath };
}

async function listEnvBackups(cwd: string): Promise<Array<{ name: string; path: string; mtimeMs: number }>> {
  const backupsDir = path.resolve(cwd, ".env_backups");
  const ok = await fs.pathExists(backupsDir);
  if (!ok) return [];
  const entries = (await fs.readdir(backupsDir)).filter((n) => n.startsWith(".env.") && n.endsWith(".bak"));
  const full = await Promise.all(
    entries.map(async (n) => {
      const p = path.join(backupsDir, n);
      const st = await fs.stat(p);
      return { name: n, path: p, mtimeMs: st.mtimeMs };
    }),
  );
  full.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return full;
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "file");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "file";
}

function sanitizeFileNamePreserveSpaces(name: string): string {
  // For SPICE include/lib files, preserving spaces is useful because netlists can reference quoted filenames.
  // We still strip path separators and invalid control characters.
  const base = path.basename(name || "file");
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const trimmed = cleaned.trim();
  return trimmed || "file";
}

async function parseMultipartSingleFile(
  req: http.IncomingMessage,
  opts: { uploadDir: string },
): Promise<{ fieldname: string; filePath: string; filename: string; originalFilename: string; mimeType: string }> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new Error("Expected multipart/form-data");
  }

  await fs.mkdirp(opts.uploadDir);

  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    let sawFile = false;
    let fileResult:
      | { fieldname: string; filePath: string; filename: string; originalFilename: string; mimeType: string }
      | undefined;
    let fileWriteDone: Promise<void> | undefined;

    // NOTE: Busboy callback signature differs across major versions:
    // - v1+: (fieldname, file, info)
    // - v0.x: (fieldname, file, filename, encoding, mimetype)
    bb.on(
      "file",
      (
        fieldname: string,
        file: NodeJS.ReadableStream,
        infoOrFilename: any,
        encodingMaybe?: any,
        mimeTypeMaybe?: any,
      ) => {
        // Only accept the first file; drain any others.
        if (sawFile) {
          file.resume();
          return;
        }
        sawFile = true;

        const originalFilename =
          typeof infoOrFilename === "string" ? String(infoOrFilename || "") : String(infoOrFilename?.filename || "");
        const mimeType =
          typeof infoOrFilename === "string"
            ? String(mimeTypeMaybe || "")
            : String(infoOrFilename?.mimeType || "");

        const safe = sanitizeFileName(originalFilename || "upload");
        const filePath = path.join(opts.uploadDir, safe);
        const out = fs.createWriteStream(filePath);

        fileWriteDone = new Promise((res, rej) => {
          file.on("error", rej);
          out.on("error", rej);
          out.on("finish", () => res());
        });

        fileResult = {
          fieldname,
          filePath,
          filename: safe,
          originalFilename: originalFilename || safe,
          mimeType: mimeType || "application/octet-stream",
        };

        file.pipe(out);
      },
    );

    bb.on("error", reject);
    bb.on("finish", () => {
      if (!sawFile || !fileResult || !fileWriteDone) {
        reject(new Error("No file received"));
        return;
      }
      fileWriteDone.then(() => resolve(fileResult!)).catch(reject);
    });

    req.pipe(bb);
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getSingleQueryParam(u: URL, name: string): string | undefined {
  const v = u.searchParams.get(name);
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function normalizeAbs(p: string): string {
  // Normalize for Windows case-insensitive comparisons
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function isWithin(childPath: string, parentPath: string): boolean {
  const c = normalizeAbs(childPath);
  const p = normalizeAbs(parentPath);
  return c === p || c.startsWith(p + path.sep);
}

function htmlPage(args: { defaultOutdir: string; cwd: string }): string {
  const safeJson = (v: any) => JSON.stringify(v).replace(/</g, "\\u003c");

  const defaults = {
    questionPath: "examples/question.md",
    baselineNetlistPath: "",
    baselineImagePath: "",
    outdir: args.defaultOutdir,
    schematicDpi: 300,
    bundleIncludes: false,
    openaiModel: "gpt-5.2",
    grokModel: "grok-4",
    geminiModel: "gemini-2.5-flash",
    claudeModel: "claude-sonnet-4-5-20250929",
    enabledProviders: ["openai", "xai", "google", "anthropic"],
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link
    rel="icon"
    href="data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2064%2064%27%3E%3Crect%20width%3D%2764%27%20height%3D%2764%27%20rx%3D%2712%27%20fill%3D%27%232563eb%27/%3E%3Cpath%20d%3D%27M32%2014l14%2036h-6l-3-8H27l-3%208h-6l14-36h6zm-3%2022h10l-5-14-5%2014z%27%20fill%3D%27white%27/%3E%3C/svg%3E"
  />
  <title>AI Schematics Ensemble</title>
  <script>
    (() => {
      const THEME_KEY = "ai-schematics-theme-v1";
      try {
        const saved = localStorage.getItem(THEME_KEY) || "system";
        if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
        else document.documentElement.removeAttribute("data-theme");
      } catch {
        // ignore
      }
    })();
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      color-scheme: light dark;
      --fg: #111827;
      --muted: #6b7280;
      --bg: #ffffff;
      --card: #f9fafb;
      --border: rgba(0, 0, 0, 0.18);
      --field-border: rgba(0, 0, 0, 0.25);
      --field-bg: rgba(127, 127, 127, 0.08);
      --btn-bg: rgba(127, 127, 127, 0.12);
      --btn-border: rgba(0, 0, 0, 0.25);
      --primary: #2563eb;
      --primary-fg: #ffffff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --fg: #e5e7eb;
        --muted: #9ca3af;
        --bg: #0b1020;
        --card: #0f172a;
        --border: rgba(255, 255, 255, 0.18);
        --field-border: rgba(255, 255, 255, 0.22);
        --field-bg: rgba(127, 127, 127, 0.12);
        --btn-bg: rgba(127, 127, 127, 0.18);
        --btn-border: rgba(255, 255, 255, 0.22);
        --primary: #3b82f6;
        --primary-fg: #ffffff;
      }
    }
    html[data-theme="light"] {
      color-scheme: light;
      --fg: #111827;
      --muted: #6b7280;
      --bg: #ffffff;
      --card: #f9fafb;
      --border: rgba(0, 0, 0, 0.18);
      --field-border: rgba(0, 0, 0, 0.25);
      --field-bg: rgba(127, 127, 127, 0.08);
      --btn-bg: rgba(127, 127, 127, 0.12);
      --btn-border: rgba(0, 0, 0, 0.25);
      --primary: #2563eb;
      --primary-fg: #ffffff;
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --bg: #0b1020;
      --card: #0f172a;
      --border: rgba(255, 255, 255, 0.18);
      --field-border: rgba(255, 255, 255, 0.22);
      --field-bg: rgba(127, 127, 127, 0.12);
      --btn-bg: rgba(127, 127, 127, 0.18);
      --btn-border: rgba(255, 255, 255, 0.22);
      --primary: #3b82f6;
      --primary-fg: #ffffff;
    }
    body { font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, Arial; margin: 0; color: var(--fg); background: var(--bg); }
    header { padding: 14px 18px; border-bottom: 1px solid var(--border); }
    main { padding: 18px; max-width: 1100px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
    .card { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--card); }
    .row { display: grid; grid-template-columns: minmax(0, 180px) minmax(0, 1fr); gap: 10px; align-items: center; margin: 10px 0; }
    .row > * { min-width: 0; }
    @media (max-width: 620px) { .row { grid-template-columns: 1fr; } }
    input[type=text], input[type=number], input[type=password] { width: 100%; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--field-border); background: var(--field-bg); color: inherit; }
    input[type=text].subduedPath { opacity: .85; }
    input[type=text].subduedPath[readonly] { cursor: default; }
    .hint { opacity: .75; font-size: 12px; color: var(--muted); }
    .sectionTitle { font-weight: 700; margin: 16px 0 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    button, .btnLike { padding: 8px 12px; border-radius: 10px; border: 1px solid var(--btn-border); background: var(--btn-bg); cursor: pointer; color: inherit; }
    .btnLike { display: inline-flex; align-items: center; justify-content: center; user-select: none; }
    button.primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button:disabled { pointer-events: none; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--field-bg); max-height: 320px; overflow: auto; }
    .ok { color: #16a34a; }
    .warn { color: #d97706; }
    .err { color: #dc2626; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; color: var(--muted); }
    .themeWrap { display: inline-flex; align-items: center; gap: 6px; }
    .themeSelect { padding: 6px 10px; border-radius: 10px; border: 1px solid var(--btn-border); background: var(--bg); color: var(--fg); }
    .themeSelect option { background: var(--bg); color: var(--fg); }
    html[data-theme="light"] .themeSelect { color-scheme: light; }
    html[data-theme="dark"] .themeSelect { color-scheme: dark; }
  </style>
</head>
<body>
  <header>
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:16px;">
      <div>
        <div style="font-weight:700;">AI Schematics Ensemble</div>
        <div class="hint">Server CWD: <span class="mono" id="cwd"></span></div>
      </div>
      <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; justify-content:flex-end;">
        <span class="themeWrap pill" title="Theme (defaults to System)">
          Theme
          <select id="themeSelect" class="themeSelect">
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </span>
        <a class="hint" href="/online-help.html" target="_blank" rel="noopener">Help</a>
        <a class="hint" href="/" target="_blank" rel="noopener">Offline config</a>
        <span class="hint">Batch runs only (for now)</span>
      </div>
    </div>
  </header>

  <main>
    <div class="grid">
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Inputs</div>

        <div class="row">
          <label>Question file</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="questionPath" type="text" value="" placeholder="(required)" readonly class="subduedPath" />
              <label class="btnLike" id="questionBrowseBtn" for="questionFile" title="Browse">...</label>
              <button type="button" id="questionClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="questionFile" type="file" accept=".md,.txt,text/plain,text/markdown" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint" id="questionPickedHint"></div>
          </div>
        </div>

        <div class="row">
          <label>Baseline netlist</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="baselineNetlistPath" type="text" value="" placeholder="(optional)" readonly class="subduedPath" />
              <label class="btnLike" id="baselineNetlistBrowseBtn" for="baselineNetlistFile" title="Browse">...</label>
              <button type="button" id="baselineNetlistClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="baselineNetlistFile" type="file" accept=".cir,.sp,.lib,.txt,text/plain" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint" id="baselineNetlistPickedHint"></div>
          </div>
        </div>

        <div class="row">
          <label>Baseline includes</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="includeSummary" type="text" value="" placeholder="(optional)" readonly class="subduedPath" />
              <label class="btnLike" id="includeBrowseBtn" for="includeFiles" title="Browse .include/.lib files">...</label>
              <button type="button" id="includeClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="includeFiles" type="file" multiple accept=".lib,.cir,.sp,.txt,text/plain" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint">Upload one or more <span class="mono">.include/.lib</span> deps so an uploaded baseline netlist can reference them by relative path.</div>
            <div class="hint" id="includeFilesList"></div>
          </div>
        </div>

        <div class="row">
          <label>Baseline image</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="baselineImagePath" type="text" value="" placeholder="(optional)" readonly class="subduedPath" />
              <label class="btnLike" id="baselineImageBrowseBtn" for="baselineImageFile" title="Browse">...</label>
              <button type="button" id="baselineImageClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="baselineImageFile" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint" id="baselineImagePickedHint"></div>
          </div>
        </div>

        <div id="uploadSnapshotWarn" class="hint" style="margin-top:10px; display:none; color:#b45309;">
          Note: one or more inputs point into <span class="mono">.ui_uploads</span> (uploaded snapshots). Re-upload after edits.
        </div>

        <div class="sectionTitle">Run &amp; Config</div>
        <div class="actions">
          <button class="primary" id="runBtn">Run</button>
          <button type="button" id="saveConfigBtn">Save config</button>
          <button type="button" id="loadConfigBtn">Load config</button>
          <button type="button" id="exportConfigBtn">Export config</button>
          <label class="btnLike" title="Import config" style="gap:8px;">Import<input id="importConfigInput" type="file" accept="application/json,.json" style="display:none" /></label>
          <button type="button" id="clearSavedBtn">Clear saved</button>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Settings</div>

        <div class="row">
          <label>Outdir</label>
          <input id="outdir" type="text" value="runs" />
        </div>

        <div class="row">
          <label>Schematic DPI</label>
          <div>
            <input id="schematicDpi" type="number" min="1" max="2400" value="" placeholder="(optional) e.g. 300" />
            <div class="hint">Controls <span class="mono">schematic.png</span> resolution (Graphviz).</div>
          </div>
        </div>

        <div class="row">
          <label>Bundle includes</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <select id="bundleIncludes" style="padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: rgba(127,127,127,.06); color: inherit;">
                <option value="false" selected>false</option>
                <option value="true">true</option>
              </select>
              <span class="hint">Copy <span class="mono">.include/.lib</span> deps into run folder</span>
            </div>
          </div>
        </div>

        <div
          style="
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 12px;
            font-weight: 700;
            margin: 14px 0 8px;
          "
        >
          <div>Models (optional)</div>
          <button type="button" id="keysOpenBtn" title="Open API keys" style="padding: 8px 10px">API Keys…</button>
        </div>
        <div class="row">
          <label style="display: flex; gap: 8px; align-items: center">
            <input id="useOpenai" type="checkbox" checked /> OpenAI model
          </label>
          <div style="display: flex; gap: 8px; align-items: center">
            <input id="openaiModel" type="text" value="gpt-5.2" />
            <button type="button" id="openaiKeyBtn" title="Enter OPENAI_API_KEY">Keys</button>
          </div>
        </div>
        <div class="row">
          <label style="display: flex; gap: 8px; align-items: center">
            <input id="useXai" type="checkbox" checked /> Grok model
          </label>
          <div style="display: flex; gap: 8px; align-items: center">
            <input id="grokModel" type="text" value="grok-4" />
            <button type="button" id="xaiKeyBtn" title="Enter XAI_API_KEY">Keys</button>
          </div>
        </div>
        <div class="row">
          <label style="display: flex; gap: 8px; align-items: center">
            <input id="useGemini" type="checkbox" checked /> Gemini model
          </label>
          <div style="display: flex; gap: 8px; align-items: center">
            <input id="geminiModel" type="text" value="gemini-2.5-flash" />
            <button type="button" id="geminiKeyBtn" title="Enter GEMINI_API_KEY">Keys</button>
          </div>
        </div>
        <div class="row">
          <label style="display: flex; gap: 8px; align-items: center">
            <input id="useAnthropic" type="checkbox" checked /> Claude model
          </label>
          <div style="display: flex; gap: 8px; align-items: center">
            <input id="claudeModel" type="text" value="claude-sonnet-4-5-20250929" />
            <button type="button" id="anthropicKeyBtn" title="Enter ANTHROPIC_API_KEY">Keys</button>
          </div>
        </div>

        <div class="hint" style="margin-top:8px;">Note: these file fields are upload-only on the online page. Use the <span class="mono">...</span> buttons to pick files.</div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div style="font-weight:700; margin-bottom:8px;">Status</div>
        <div id="status" class="hint">Idle.</div>
        <div class="actions" style="margin-top:8px;">
          <button id="openRunDirBtn" disabled title="Opens the run folder on the server machine (Explorer/Finder).">Open run folder</button>
          <button id="downloadFinalMdBtn" disabled>Download final.md</button>
          <button id="downloadFinalCirBtn" disabled>Download final.cir</button>
          <button id="downloadSchematicPngBtn" disabled>Download SPICE netlist PNG</button>
          <button id="viewSchematicPngBtn" disabled>View SPICE netlist PNG image</button>
          <button id="downloadAnswersMdBtn" disabled>Download AI .md files</button>
          <button id="downloadReportBtn" disabled>Download report.docx</button>
          <button id="downloadReportPdfBtn" disabled>Download report.pdf</button>
        </div>
        <pre id="log"></pre>
      </div>
    </div>
  </main>

  <div id="keysModal" style="position:fixed; inset:0; display:none; align-items:center; justify-content:center; background: rgba(0,0,0,.55); padding: 16px;">
    <div style="width:min(780px, 100%); background: rgba(20,20,20,.92); border:1px solid rgba(127,127,127,.35); border-radius: 14px; padding: 14px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap: 12px;">
        <div style="font-weight:700;">API Keys</div>
        <button type="button" id="keysCloseBtn" title="Close" style="padding: 8px 10px;">✕</button>
      </div>
      <div class="hint" style="margin: 6px 0 12px;">Stored in browser <span class="mono">localStorage</span> for the online page, and sent to the server only when you click <b>Run</b>.</div>

      <form onsubmit="return false">
        <div class="row"><label>OPENAI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envOpenai" type="password" placeholder="(optional)" autocomplete="off" /><button type="button" id="showOpenai">Show</button></div></div>
        <div class="row"><label>XAI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envXai" type="password" placeholder="(optional)" autocomplete="off" /><button type="button" id="showXai">Show</button></div></div>
        <div class="row"><label>GEMINI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envGemini" type="password" placeholder="(optional)" autocomplete="off" /><button type="button" id="showGemini">Show</button></div></div>
        <div class="row"><label>ANTHROPIC_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envAnthropic" type="password" placeholder="(optional)" autocomplete="off" /><button type="button" id="showAnthropic">Show</button></div></div>
      </form>

      <div class="actions" style="margin-top: 12px;">
        <button type="button" class="primary" id="keysSaveBtn">Save</button>
        <span class="hint" id="keysStatus" style="align-self:center;"></span>
      </div>
    </div>
  </div>

  <script id="uiInit" type="application/json">${safeJson({ cwd: args.cwd, defaults })}</script>
  <script>
    (() => {
      const THEME_KEY = "ai-schematics-theme-v1";
      const apply = (c) => {
        if (c === "dark" || c === "light") document.documentElement.dataset.theme = c;
        else document.documentElement.removeAttribute("data-theme");
      };
      const getSaved = () => {
        try {
          return localStorage.getItem(THEME_KEY) || "system";
        } catch {
          return "system";
        }
      };
      const save = (c) => {
        try {
          if (c === "dark" || c === "light") localStorage.setItem(THEME_KEY, c);
          else localStorage.removeItem(THEME_KEY);
        } catch {
          // ignore
        }
      };

      const saved = getSaved();
      apply(saved);

      window.addEventListener("DOMContentLoaded", () => {
        const sel = document.getElementById("themeSelect");
        if (!sel) return;
        sel.value = saved === "dark" || saved === "light" ? saved : "system";
        sel.addEventListener("change", () => {
          const v = sel.value;
          apply(v);
          save(v);
        });
      });
    })();
  </script>
  <script type="module" src="/assets/onlineClient.js"></script>
</body>
</html>`;
}

async function openBrowser(urlToOpen: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      // cmd's start needs a window title argument
      await execa("cmd", ["/c", "start", "", urlToOpen]);
      return;
    }
    if (process.platform === "darwin") {
      await execa("open", [urlToOpen]);
      return;
    }
    await execa("xdg-open", [urlToOpen]);
  } catch {
    // ignore
  }
}

export async function startUiServer(opts: UiServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 3210;
  const defaultOutdir = opts.outdir ?? "runs";
  const cwd = process.cwd();

  const instanceId = crypto.randomUUID();

  const uploadRootDir = path.resolve(cwd, ".ui_uploads");
  const envPath = path.resolve(cwd, ".env");
  const envBackupsDir = path.resolve(cwd, ".env_backups");

  const allowedRunDirs = new Set<string>();

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url ?? "", true);
      const method = (req.method ?? "GET").toUpperCase();
      const pathname = parsed.pathname ?? "/";

      if (method === "GET" && pathname === "/help.html") {
        const p = path.resolve(cwd, "help.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "help.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/offline-help.html") {
        const p = path.resolve(cwd, "offline-help.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "offline-help.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/online-help.html") {
        const p = path.resolve(cwd, "online-help.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "online-help.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/cli-help.html") {
        const p = path.resolve(cwd, "cli-help.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "cli-help.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/favicon.ico") {
        // Silence default browser favicon requests.
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/offline.html") {
        const p = path.resolve(cwd, "offline.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "offline.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/online") {
        sendText(res, 200, "text/html; charset=utf-8", htmlPage({ defaultOutdir, cwd }));
        return;
      }

      if (method === "GET" && pathname === "/online.html") {
        sendText(res, 200, "text/html; charset=utf-8", htmlPage({ defaultOutdir, cwd }));
        return;
      }

      if (method === "GET" && pathname === "/") {
        // Default landing page: offline config generator.
        const p = path.resolve(cwd, "offline.html");
        const ok = await fs.pathExists(p);
        if (!ok) {
          sendText(res, 404, "text/plain; charset=utf-8", "offline.html not found");
          return;
        }
        const body = await fs.readFile(p, "utf8");
        sendText(res, 200, "text/html; charset=utf-8", body);
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/dev/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });

        res.write(`event: instance\ndata: ${instanceId}\n\n`);

        const heartbeat = setInterval(() => {
          try {
            res.write(`: ping ${Date.now()}\n\n`);
          } catch {
            // ignore
          }
        }, 15000);

        req.on("close", () => {
          clearInterval(heartbeat);
        });

        return;
      }

      if (method === "GET" && pathname === "/assets/onlineClient.js") {
        try {
          const p = path.join(cwd, "dist", "ui", "onlineClient.js");
          const ok = await fs.pathExists(p);
          if (!ok) {
            sendText(res, 404, "text/plain; charset=utf-8", "onlineClient.js not found");
            return;
          }
          const body = await fs.readFile(p, "utf8");
          sendText(res, 200, "application/javascript; charset=utf-8", body);
        } catch (e: any) {
          sendText(res, 500, "text/plain; charset=utf-8", String(e?.message ?? e));
        }
        return;
      }

      if (method === "POST" && pathname === "/api/upload") {
        try {
          const contentType = String(req.headers["content-type"] ?? "");
          const u = new URL(req.url || "/api/upload", `http://${String(req.headers.host ?? "localhost")}`);
          const kind = getSingleQueryParam(u, "kind");
          const kindIsInclude = kind === "include";
          const kindBase =
            kind === "question"
              ? "question"
              : kind === "baselineNetlist"
                ? "baseline_netlist"
                : kind === "baselineImage"
                  ? "baseline_image"
                  : undefined;

          const toUserPath = (absPath: string): string => {
            try {
              const rel = path.relative(cwd, absPath);
              if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
              return rel;
            } catch {
              return absPath;
            }
          };

          const folder = `${Date.now()}_${crypto.randomUUID()}`;
          const uploadDir = path.join(uploadRootDir, "tmp", folder);

          // Prefer multipart/form-data, but support a raw-body fallback.
          if (contentType.toLowerCase().startsWith("multipart/form-data")) {
            const received = await parseMultipartSingleFile(req, { uploadDir });
            if (kindIsInclude) {
              const currentDir = path.join(uploadRootDir, "current");
              await fs.mkdirp(currentDir);
              const safeName = sanitizeFileNamePreserveSpaces(received.originalFilename || received.filename || "include.lib");
              const stableAbsPath = path.join(currentDir, safeName);
              await fs.move(received.filePath, stableAbsPath, { overwrite: true });
              await fs.remove(uploadDir).catch(() => undefined);
              sendJson(res, 200, {
                ok: true,
                path: toUserPath(stableAbsPath),
                filename: path.basename(stableAbsPath),
                mimeType: received.mimeType,
                originalFilename: received.originalFilename,
                kind,
              });
              return;
            }
            if (kindBase) {
              const ext0 = String(path.extname(received.filename || "")).toLowerCase();
              const ext = ext0 && ext0.length <= 16 ? ext0 : "";
              const currentDir = path.join(uploadRootDir, "current");
              await fs.mkdirp(currentDir);
              const stableAbsPath = path.join(currentDir, `${kindBase}${ext || ".bin"}`);
              await fs.move(received.filePath, stableAbsPath, { overwrite: true });
              // Best-effort cleanup of temp dir
              await fs.remove(uploadDir).catch(() => undefined);
              sendJson(res, 200, {
                ok: true,
                path: toUserPath(stableAbsPath),
                filename: path.basename(stableAbsPath),
                mimeType: received.mimeType,
                originalFilename: received.originalFilename,
                kind,
              });
              return;
            }

            sendJson(res, 200, { ok: true, path: toUserPath(received.filePath), filename: received.filename, mimeType: received.mimeType, kind });
            return;
          }

          // Raw upload fallback: body is file bytes.
          // Client provides the filename via query or x-filename header.
          const qName = getSingleQueryParam(u, "filename");
          const hName = String(req.headers["x-filename"] ?? "").trim();
          const requested = qName || hName;
          if (!requested) {
            sendJson(res, 400, { error: "Missing filename (expected ?filename=... or x-filename header)" });
            return;
          }

          const safe = kindIsInclude ? sanitizeFileNamePreserveSpaces(requested) : sanitizeFileName(requested);
          const body = await readRequestBody(req);
          if (!body || body.length === 0) {
            sendJson(res, 400, { error: "Empty body" });
            return;
          }

          if (kindIsInclude) {
            const currentDir = path.join(uploadRootDir, "current");
            await fs.mkdirp(currentDir);
            const stableAbsPath = path.join(currentDir, safe || "include.lib");
            await fs.writeFile(stableAbsPath, body);
            sendJson(res, 200, {
              ok: true,
              path: toUserPath(stableAbsPath),
              filename: path.basename(stableAbsPath),
              mimeType: contentType || "application/octet-stream",
              originalFilename: requested,
              kind,
            });
            return;
          }

          if (kindBase) {
            const ext0 = String(path.extname(safe || "")).toLowerCase();
            const ext = ext0 && ext0.length <= 16 ? ext0 : "";
            const currentDir = path.join(uploadRootDir, "current");
            await fs.mkdirp(currentDir);
            const stableAbsPath = path.join(currentDir, `${kindBase}${ext || ".bin"}`);
            await fs.writeFile(stableAbsPath, body);
            sendJson(res, 200, {
              ok: true,
              path: toUserPath(stableAbsPath),
              filename: path.basename(stableAbsPath),
              mimeType: contentType || "application/octet-stream",
              originalFilename: safe,
              kind,
            });
            return;
          }

          await fs.mkdirp(uploadDir);
          const filePath = path.join(uploadDir, safe);
          await fs.writeFile(filePath, body);
          sendJson(res, 200, { ok: true, path: toUserPath(filePath), filename: safe, mimeType: contentType || "application/octet-stream", kind });
        } catch (e: any) {
          sendJson(res, 400, { error: String(e?.message ?? e) });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/exists") {
        try {
          const body = await readRequestBody(req);
          const payload = JSON.parse(body.toString("utf-8") || "{}");
          const pathsRaw: unknown = payload?.paths;
          const paths: string[] = Array.isArray(pathsRaw)
            ? pathsRaw.map((p: any) => String(p || "").trim()).filter((p: string) => p)
            : [];

          const limited = paths.slice(0, 200);
          const results = await Promise.all(
            limited.map(async (p) => {
              const abs = path.resolve(cwd, p);
              const allowed = isWithin(abs, cwd);
              const exists = allowed ? await fs.pathExists(abs) : false;
              return { path: p, allowed, exists };
            }),
          );

          sendJson(res, 200, { ok: true, results });
        } catch (e: any) {
          sendJson(res, 500, { error: String(e?.message ?? e) });
        }
        return;
      }

      if (method === "GET" && pathname === "/api/env") {
        const exists = await fs.pathExists(envPath);
        const raw = exists ? await fs.readFile(envPath, "utf8") : "";
        const parsed = parseEnvText(raw);
        const backups = await listEnvBackups(cwd);
        sendJson(res, 200, {
          ok: true,
          exists,
          keys: {
            OPENAI_API_KEY: parsed.OPENAI_API_KEY || "",
            XAI_API_KEY: parsed.XAI_API_KEY || "",
            GEMINI_API_KEY: parsed.GEMINI_API_KEY || "",
            ANTHROPIC_API_KEY: parsed.ANTHROPIC_API_KEY || "",
          },
          backups: backups.map((b) => ({ name: b.name })),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/env") {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body.toString("utf-8") || "{}");
        const keys = (payload?.keys ?? {}) as Partial<Record<EnvKeyName, unknown>>;

        const updates: Partial<Record<EnvKeyName, string | undefined>> = {
          OPENAI_API_KEY: typeof keys.OPENAI_API_KEY === "string" ? keys.OPENAI_API_KEY : undefined,
          XAI_API_KEY: typeof keys.XAI_API_KEY === "string" ? keys.XAI_API_KEY : undefined,
          GEMINI_API_KEY: typeof keys.GEMINI_API_KEY === "string" ? keys.GEMINI_API_KEY : undefined,
          ANTHROPIC_API_KEY: typeof keys.ANTHROPIC_API_KEY === "string" ? keys.ANTHROPIC_API_KEY : undefined,
        };

        await ensureEnvBackup({ cwd, maxBackups: 25 });
        const exists = await fs.pathExists(envPath);
        const prev = exists ? await fs.readFile(envPath, "utf8") : "";
        const next = upsertEnvLines(prev, updates);
        await fs.writeFile(envPath, next, "utf8");

        const backups = await listEnvBackups(cwd);
        sendJson(res, 200, { ok: true, backups: backups.map((b) => ({ name: b.name })) });
        return;
      }

      if (method === "POST" && pathname === "/api/env/restore") {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body.toString("utf-8") || "{}");
        const name = String(payload?.name ?? "");
        if (!name || !name.startsWith(".env.") || !name.endsWith(".bak")) {
          sendJson(res, 400, { error: "Invalid backup name" });
          return;
        }

        const target = path.resolve(envBackupsDir, name);
        const allowed = isWithin(target, envBackupsDir);
        if (!allowed) {
          sendJson(res, 403, { error: "Not allowed" });
          return;
        }

        const ok = await fs.pathExists(target);
        if (!ok) {
          sendJson(res, 404, { error: "Backup not found" });
          return;
        }

        await ensureEnvBackup({ cwd, maxBackups: 25 });
        await fs.copy(target, envPath);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/run") {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body.toString("utf-8") || "{}");

        const schematicDpiRaw = payload.schematicDpi;
        const schematicDpi =
          schematicDpiRaw == null || String(schematicDpiRaw).trim() === ""
            ? undefined
            : Number.parseInt(String(schematicDpiRaw).trim(), 10);

        const runOpts: RunBatchOptions = {
          questionPath: String(payload.questionPath ?? ""),
          baselineNetlistPath: payload.baselineNetlistPath ? String(payload.baselineNetlistPath) : undefined,
          baselineImagePath: payload.baselineImagePath ? String(payload.baselineImagePath) : undefined,
          bundleIncludes: Boolean(payload.bundleIncludes),
          outdir: payload.outdir ? String(payload.outdir) : defaultOutdir,
          schematicDpi: Number.isFinite(schematicDpi) && (schematicDpi as number) > 0 ? (schematicDpi as number) : undefined,
          openaiModel: payload.openaiModel ? String(payload.openaiModel) : undefined,
          grokModel: payload.grokModel ? String(payload.grokModel) : undefined,
          geminiModel: payload.geminiModel ? String(payload.geminiModel) : undefined,
          claudeModel: payload.claudeModel ? String(payload.claudeModel) : undefined,
          enabledProviders: Array.isArray(payload.enabledProviders)
            ? payload.enabledProviders
                .map((p: any) => String(p || "").trim().toLowerCase())
                .filter((p: string) => p === "openai" || p === "xai" || p === "google" || p === "anthropic")
            : undefined,
          allowPrompts: false,
        };

        if (!runOpts.questionPath || !runOpts.questionPath.trim()) {
          sendJson(res, 400, { error: "questionPath is required" });
          return;
        }

        const logs: string[] = [];
        const logger: RunBatchLogger = {
          info: (m) => logs.push(m),
          warn: (m) => logs.push("WARN: " + m),
          error: (m) => logs.push("ERROR: " + m),
        };

        // Online page can optionally supply API keys (stored in browser localStorage).
        // Apply them to this process for the duration of the run, then restore.
        const apiKeys = payload?.apiKeys && typeof payload.apiKeys === "object" ? (payload.apiKeys as Record<string, unknown>) : undefined;
        const keyNames: EnvKeyName[] = ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"];
        const prevEnv: Partial<Record<EnvKeyName, string | undefined>> = {};
        if (apiKeys) {
          for (const k of keyNames) prevEnv[k] = process.env[k];
          for (const k of keyNames) {
            const v = apiKeys[k];
            if (typeof v === "string" && v.trim()) process.env[k] = v.trim();
          }
        }

        let result: RunBatchResult;
        try {
          result = await runBatch(runOpts, logger);
        } catch (e: any) {
          // Even if the run fails, runBatch typically created a run directory and logged it.
          // Returning it lets the UI enable "Open run folder" for troubleshooting.
          let runDir: string | undefined;
          for (const line of logs) {
            if (typeof line === "string" && line.startsWith("Run directory:")) {
              const maybe = line.slice("Run directory:".length).trim();
              if (maybe) {
                runDir = maybe;
                break;
              }
            }
          }

          if (runDir) allowedRunDirs.add(path.resolve(runDir));

          sendJson(res, 500, { error: String(e?.message ?? e), logs, runDir });
          return;
        } finally {
          if (apiKeys) {
            for (const k of keyNames) {
              const prior = prevEnv[k];
              if (typeof prior === "string") process.env[k] = prior;
              else delete process.env[k];
            }
          }
        }

        allowedRunDirs.add(path.resolve(result.runDir));
        sendJson(res, 200, { ...result, logs });
        return;
      }

      if (method === "POST" && pathname === "/api/open") {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body.toString("utf-8") || "{}");
        const target = String(payload.path ?? "");
        if (!target) {
          sendJson(res, 400, { error: "path is required" });
          return;
        }

        const abs = path.resolve(target);
        const allowed = Array.from(allowedRunDirs).some((d) => isWithin(abs, d));
        if (!allowed) {
          sendJson(res, 403, { error: "Not an allowed run directory" });
          return;
        }

        const exists = await fs.pathExists(abs);
        if (!exists) {
          sendJson(res, 404, { error: "Path does not exist", path: abs });
          return;
        }

        let isDir = false;
        try {
          const st = await fs.stat(abs);
          isDir = st.isDirectory();
        } catch {
          // ignore; handled below
        }

        if (!isDir) {
          sendJson(res, 400, { error: "Path is not a directory", path: abs });
          return;
        }

        try {
          const attempts: Array<{ cmd: string; args: string[] }> = [];
          if (process.platform === "win32") {
            // Try a few strategies; return which one we used.
            attempts.push({ cmd: "explorer.exe", args: [abs] });
            attempts.push({ cmd: "cmd.exe", args: ["/c", "start", "", abs] });

            let opened: { cmd: string; args: string[] } | undefined;
            let lastErr: any;
            for (const a of attempts) {
              try {
                if (a.cmd.toLowerCase() === "explorer.exe") {
                  await spawnDetached(a.cmd, a.args);
                } else {
                  await spawnDetached(a.cmd, a.args);
                }
                opened = a;
                break;
              } catch (e: any) {
                lastErr = e;
              }
            }

            if (!opened) {
              throw lastErr ?? new Error("Failed to launch Explorer");
            }

            sendJson(res, 200, { ok: true, path: abs, openedWith: opened.cmd, openedArgs: opened.args });
            return;
          } else if (process.platform === "darwin") {
            attempts.push({ cmd: "open", args: [abs] });
            await execa("open", [abs]);
          } else {
            attempts.push({ cmd: "xdg-open", args: [abs] });
            await execa("xdg-open", [abs]);
          }
          sendJson(res, 200, { ok: true, path: abs });
        } catch (e: any) {
          sendJson(res, 500, { error: String(e?.message ?? e), path: abs });
        }
        return;
      }

      if (method === "GET" && pathname === "/api/file") {
        const p = String(parsed.query.path ?? "");
        if (!p) {
          sendJson(res, 400, { error: "path is required" });
          return;
        }

        const abs = path.resolve(p);
        const allowed = Array.from(allowedRunDirs).some((d) => isWithin(abs, d));
        if (!allowed) {
          sendJson(res, 403, { error: "Not an allowed file" });
          return;
        }

        const ok = await fs.pathExists(abs);
        if (!ok) {
          sendJson(res, 404, { error: "File not found" });
          return;
        }

        // Basic content-type
        const ext = path.extname(abs).toLowerCase();
        const ct =
          ext === ".md" || ext === ".txt"
            ? "text/plain; charset=utf-8"
            : ext === ".json"
              ? "application/json; charset=utf-8"
              : ext === ".png"
                ? "image/png"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : ext === ".webp"
                    ? "image/webp"
                    : ext === ".docx"
                      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      : ext === ".pdf"
                        ? "application/pdf"
                      : "application/octet-stream";

        res.writeHead(200, {
          "content-type": ct,
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${path.basename(abs)}"`,
        });

        fs.createReadStream(abs).pipe(res);
        return;
      }

      if (method === "GET" && pathname === "/api/view") {
        const p = String(parsed.query.path ?? "");
        if (!p) {
          sendJson(res, 400, { error: "path is required" });
          return;
        }

        const abs = path.resolve(p);
        const allowed = Array.from(allowedRunDirs).some((d) => isWithin(abs, d));
        if (!allowed) {
          sendJson(res, 403, { error: "Not an allowed file" });
          return;
        }

        const ok = await fs.pathExists(abs);
        if (!ok) {
          sendJson(res, 404, { error: "File not found" });
          return;
        }

        // Basic content-type (same as /api/file, but served inline)
        const ext = path.extname(abs).toLowerCase();
        const ct =
          ext === ".md" || ext === ".txt"
            ? "text/plain; charset=utf-8"
            : ext === ".json"
              ? "application/json; charset=utf-8"
              : ext === ".png"
                ? "image/png"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : ext === ".webp"
                    ? "image/webp"
                    : ext === ".svg"
                      ? "image/svg+xml; charset=utf-8"
                      : ext === ".pdf"
                        ? "application/pdf"
                      : "application/octet-stream";

        res.writeHead(200, {
          "content-type": ct,
          "cache-control": "no-store",
        });

        fs.createReadStream(abs).pipe(res);
        return;
      }

      if (method === "GET" && pathname === "/api/answers-md") {
        const runDirRaw = String(parsed.query.runDir ?? "");
        if (!runDirRaw) {
          sendJson(res, 400, { error: "runDir is required" });
          return;
        }

        const runDirAbs = path.resolve(runDirRaw);
        const allowed = Array.from(allowedRunDirs).some((d) => isWithin(runDirAbs, d));
        if (!allowed) {
          sendJson(res, 403, { error: "Not an allowed run directory" });
          return;
        }

        const answersDir = path.join(runDirAbs, "answers");
        const ok = await fs.pathExists(answersDir);
        if (!ok) {
          sendJson(res, 404, { error: "answers folder not found" });
          return;
        }

        const entries = await fs.readdir(answersDir);
        const mdFiles = entries
          .filter((n) => typeof n === "string" && n.toLowerCase().endsWith(".md"))
          .sort((a, b) => a.localeCompare(b));

        if (!mdFiles.length) {
          sendJson(res, 404, { error: "No .md files found in answers folder" });
          return;
        }

        const base = path.basename(runDirAbs) || "run";
        const zipName = `answers_md_${base}.zip`;

        res.writeHead(200, {
          "content-type": "application/zip",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${zipName}"`,
        });

        const zip = archiver("zip", { zlib: { level: 9 } });
        zip.on("error", (err: any) => {
          try {
            res.destroy(err);
          } catch {
            // ignore
          }
        });

        zip.pipe(res);
        for (const name of mdFiles) {
          zip.file(path.join(answersDir, name), { name });
        }

        void zip.finalize();
        return;
      }

      sendText(res, 404, "text/plain; charset=utf-8", "Not found");
    } catch (e: any) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });

  const maxPortAttempts = 25;
  let boundPort = requestedPort;

  const listening = await (async () => {
    for (let i = 0; i <= maxPortAttempts; i++) {
      const p = requestedPort + i;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: any) => {
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };

          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(p, host);
        });
        boundPort = p;
        return { url: `http://${host}:${p}/` };
      } catch (e: any) {
        if (e && typeof e === "object" && e.code === "EADDRINUSE") continue;
        throw e;
      }
    }
    throw new Error(`No available port found in range ${requestedPort}-${requestedPort + maxPortAttempts}`);
  })();

  if (opts.openBrowser ?? true) await openBrowser(listening.url);

  return {
    url: listening.url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
