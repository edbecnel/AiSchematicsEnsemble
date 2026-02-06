import http from "node:http";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import fs from "fs-extra";
import { execa } from "execa";
import Busboy from "busboy";

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

async function parseMultipartSingleFile(req: http.IncomingMessage, opts: { uploadDir: string }): Promise<{ fieldname: string; filePath: string; filename: string; mimeType: string }> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new Error("Expected multipart/form-data");
  }

  await fs.mkdirp(opts.uploadDir);

  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    let resolved = false;
    bb.on("file", (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
      const safe = sanitizeFileName(info.filename || "upload");
      const filePath = path.join(opts.uploadDir, safe);
      const out = fs.createWriteStream(filePath);

      file.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => {
        if (resolved) return;
        resolved = true;
        resolve({ fieldname, filePath, filename: safe, mimeType: info.mimeType || "application/octet-stream" });
      });

      file.pipe(out);
    });

    bb.on("error", reject);
    bb.on("finish", () => {
      if (!resolved) reject(new Error("No file received"));
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Schematics Ensemble</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, Arial; margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid rgba(127,127,127,.3); }
    main { padding: 18px; max-width: 1100px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
    .card { border: 1px solid rgba(127,127,127,.3); border-radius: 12px; padding: 14px; }
    .row { display: grid; grid-template-columns: minmax(0, 180px) minmax(0, 1fr); gap: 10px; align-items: center; margin: 10px 0; }
    .row > * { min-width: 0; }
    @media (max-width: 620px) { .row { grid-template-columns: 1fr; } }
    input[type=text], input[type=number], input[type=password] { width: 100%; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: rgba(127,127,127,.06); color: inherit; }
    .hint { opacity: .75; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    button, .btnLike { padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(127,127,127,.4); background: rgba(127,127,127,.12); cursor: pointer; }
    .btnLike { display: inline-flex; align-items: center; justify-content: center; user-select: none; }
    button.primary { background: #2563eb; color: white; border-color: #2563eb; }
    button.danger { background: rgba(220,38,38,.1); border-color: rgba(220,38,38,.4); }
    pre { white-space: pre-wrap; word-break: break-word; padding: 10px; border-radius: 10px; border: 1px solid rgba(127,127,127,.3); background: rgba(127,127,127,.06); max-height: 320px; overflow: auto; }
    .ok { color: #16a34a; }
    .warn { color: #d97706; }
    .err { color: #dc2626; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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
        <a class="hint" href="/help.html" target="_blank" rel="noopener">Help</a>
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
              <input id="questionPath" type="text" value="examples/question.md" placeholder="examples/question.md" />
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
              <input id="baselineNetlistPath" type="text" value="" placeholder="(optional)" />
              <label class="btnLike" id="baselineNetlistBrowseBtn" for="baselineNetlistFile" title="Browse">...</label>
              <button type="button" id="baselineNetlistClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="baselineNetlistFile" type="file" accept=".cir,.sp,.lib,.txt,text/plain" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint" id="baselineNetlistPickedHint"></div>
          </div>
        </div>

        <div class="row">
          <label>Baseline image</label>
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="baselineImagePath" type="text" value="" placeholder="(optional)" />
              <label class="btnLike" id="baselineImageBrowseBtn" for="baselineImageFile" title="Browse">...</label>
              <button type="button" id="baselineImageClearBtn" title="Clear" style="padding: 8px 10px;">✕</button>
              <input id="baselineImageFile" type="file" accept="image/*" style="position:absolute; left:-10000px; width:1px; height:1px; opacity:0" />
            </div>
            <div class="hint" id="baselineImagePickedHint"></div>
          </div>
        </div>

        <div class="row"><label>Outdir</label><input id="outdir" type="text" value="${args.defaultOutdir}" placeholder="runs" /></div>
        <div class="row">
          <label>Bundle includes</label>
          <div>
            <label><input id="bundleIncludes" type="checkbox" /> Copy <span class="mono">.include/.lib</span> deps into run folder</label>
            <div class="hint">Only works when baseline netlist is a file path (not pasted).</div>
          </div>
        </div>

        <div class="actions">
          <button class="primary" id="runBtn">Run</button>
          <button id="saveConfigBtn">Save config</button>
          <button id="loadConfigBtn">Load config</button>
          <button id="exportConfigBtn">Export JSON</button>
          <label class="hint" style="display:inline-flex; align-items:center; gap:8px;">Import JSON <input id="importConfigInput" type="file" accept="application/json" /></label>
          <button class="danger" id="clearSavedBtn">Clear saved</button>
        </div>

        <div class="hint" style="margin-top:10px;">Paths are resolved on the server (this machine), relative to the server CWD shown above.</div>
      </div>

      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Models</div>
        <div class="hint" style="margin-bottom:8px;">Optional: leave blank to use defaults.</div>
        <div class="row">
          <label>OpenAI model</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="openaiModel" type="text" value="gpt-5.2" placeholder="gpt-5.2" />
            <button type="button" id="openaiKeyBtn" title="Edit OPENAI_API_KEY">...</button>
          </div>
        </div>
        <div class="row">
          <label>Grok model</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="grokModel" type="text" value="grok-4" placeholder="grok-4" />
            <button type="button" id="xaiKeyBtn" title="Edit XAI_API_KEY">...</button>
          </div>
        </div>
        <div class="row">
          <label>Gemini model</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="geminiModel" type="text" value="gemini-2.5-flash" placeholder="gemini-2.5-flash" />
            <button type="button" id="geminiKeyBtn" title="Edit GEMINI_API_KEY">...</button>
          </div>
        </div>
        <div class="row">
          <label>Claude model</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="claudeModel" type="text" value="claude-sonnet-4-5-20250929" placeholder="claude-sonnet-4-5-20250929" />
            <button type="button" id="anthropicKeyBtn" title="Edit ANTHROPIC_API_KEY">...</button>
          </div>
        </div>

        <div class="hint" style="margin:10px 0 0;">Keys are stored in <span class="mono">.env</span>. Saving creates backups in <span class="mono">.env_backups/</span>.</div>

        <div style="font-weight:700; margin:14px 0 8px;">Copy/paste commands</div>
        <div class="hint">Use this to run from PowerShell or cmd.exe without the UI.</div>
        <div class="row"><label>Config filename</label><input id="configFilename" type="text" value="ai-schematics.config.json" /></div>
        <div class="row">
          <label>Chat provider</label>
          <select id="chatProvider">
            <option value="openai">openai</option>
            <option value="xai">xai</option>
            <option value="google">google</option>
            <option value="anthropic">anthropic</option>
            <option value="ensemble">ensemble</option>
          </select>
        </div>
        <div class="row"><label>Max history</label><input id="chatMaxHistory" type="number" min="0" max="50" value="10" /></div>
        <div class="row">
          <label>Save transcript</label>
          <label style="display:inline-flex; align-items:center; gap:8px;">
            <input id="chatSave" type="checkbox" />
            <span class="hint">Saves to <span class="mono">outdir</span></span>
          </label>
        </div>
        <div class="actions" style="margin-top:6px;">
          <button id="updateCmdBtn">Update preview</button>
          <button id="copyJsonPsBtn">Copy config cmd (PowerShell)</button>
          <button id="copyJsonCmdBtn">Copy config cmd (cmd.exe)</button>
          <button id="copyChatPsBtn">Copy chat cmd (PowerShell)</button>
          <button id="copyChatCmdBtn">Copy chat cmd (cmd.exe)</button>
        </div>
        <div id="uploadSnapshotWarn" class="hint" style="margin-top:10px; display:none; color:#b45309;">
          Note: one or more inputs point into <span class="mono">.ui_uploads</span> (uploaded snapshots). If you edit your original files,
          re-upload (pick them again) or paste the real source paths.
        </div>
        <pre id="cmdPreview"></pre>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div style="font-weight:700; margin-bottom:8px;">Status</div>
        <div id="status" class="hint">Idle.</div>
        <div class="actions" style="margin-top:8px;">
          <button id="openRunDirBtn" disabled>Open run folder</button>
          <button id="downloadFinalMdBtn" disabled>Download final.md</button>
          <button id="downloadFinalCirBtn" disabled>Download final.cir</button>
          <button id="downloadReportBtn" disabled>Download report.docx</button>
        </div>
        <pre id="log"></pre>
      </div>
    </div>
  </main>

<script>
  // Dev-friendly live reload: if the UI server restarts (e.g. via node --watch),
  // this SSE stream reconnects and we reload the page exactly once.
  (function liveReload() {
    try {
      const es = new EventSource('/api/dev/events');
      es.addEventListener('instance', (ev) => {
        const id = String(ev.data || '');
        if (!id) return;
        const key = 'aiSchematicsUiInstanceId';
        const prev = sessionStorage.getItem(key);
        sessionStorage.setItem(key, id);
        if (prev && prev !== id) location.reload();
      });
    } catch {
      // ignore
    }
  })();

  window.addEventListener('DOMContentLoaded', () => {

  const DEFAULTS = ${safeJson({
    questionPath: "examples/question.md",
    baselineNetlistPath: "",
    baselineImagePath: "",
    outdir: args.defaultOutdir,
    bundleIncludes: false,
    openaiModel: "gpt-5.2",
    grokModel: "grok-4",
    geminiModel: "gemini-2.5-flash",
    claudeModel: "claude-sonnet-4-5-20250929",
  })};

  const CWD = ${safeJson(args.cwd)};
  document.getElementById('cwd').textContent = CWD;

  const els = {
    questionPath: document.getElementById('questionPath'),
    baselineNetlistPath: document.getElementById('baselineNetlistPath'),
    baselineImagePath: document.getElementById('baselineImagePath'),
    questionFile: document.getElementById('questionFile'),
    baselineNetlistFile: document.getElementById('baselineNetlistFile'),
    baselineImageFile: document.getElementById('baselineImageFile'),
    questionBrowseBtn: document.getElementById('questionBrowseBtn'),
    baselineNetlistBrowseBtn: document.getElementById('baselineNetlistBrowseBtn'),
    baselineImageBrowseBtn: document.getElementById('baselineImageBrowseBtn'),
    questionClearBtn: document.getElementById('questionClearBtn'),
    baselineNetlistClearBtn: document.getElementById('baselineNetlistClearBtn'),
    baselineImageClearBtn: document.getElementById('baselineImageClearBtn'),
    questionPickedHint: document.getElementById('questionPickedHint'),
    baselineNetlistPickedHint: document.getElementById('baselineNetlistPickedHint'),
    baselineImagePickedHint: document.getElementById('baselineImagePickedHint'),
    outdir: document.getElementById('outdir'),
    bundleIncludes: document.getElementById('bundleIncludes'),
    openaiModel: document.getElementById('openaiModel'),
    grokModel: document.getElementById('grokModel'),
    geminiModel: document.getElementById('geminiModel'),
    claudeModel: document.getElementById('claudeModel'),
    openaiKeyBtn: document.getElementById('openaiKeyBtn'),
    xaiKeyBtn: document.getElementById('xaiKeyBtn'),
    geminiKeyBtn: document.getElementById('geminiKeyBtn'),
    anthropicKeyBtn: document.getElementById('anthropicKeyBtn'),
    configFilename: document.getElementById('configFilename'),
    updateCmdBtn: document.getElementById('updateCmdBtn'),
    copyJsonPsBtn: document.getElementById('copyJsonPsBtn'),
    copyJsonCmdBtn: document.getElementById('copyJsonCmdBtn'),
    copyChatPsBtn: document.getElementById('copyChatPsBtn'),
    copyChatCmdBtn: document.getElementById('copyChatCmdBtn'),
    chatProvider: document.getElementById('chatProvider'),
    chatMaxHistory: document.getElementById('chatMaxHistory'),
    chatSave: document.getElementById('chatSave'),
    cmdPreview: document.getElementById('cmdPreview'),
    uploadSnapshotWarn: document.getElementById('uploadSnapshotWarn'),
    status: document.getElementById('status'),
    log: document.getElementById('log'),
    runBtn: document.getElementById('runBtn'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    loadConfigBtn: document.getElementById('loadConfigBtn'),
    exportConfigBtn: document.getElementById('exportConfigBtn'),
    importConfigInput: document.getElementById('importConfigInput'),
    clearSavedBtn: document.getElementById('clearSavedBtn'),
    openRunDirBtn: document.getElementById('openRunDirBtn'),
    downloadFinalMdBtn: document.getElementById('downloadFinalMdBtn'),
    downloadFinalCirBtn: document.getElementById('downloadFinalCirBtn'),
    downloadReportBtn: document.getElementById('downloadReportBtn'),
  };

  const keysUi = {
    modal: document.getElementById('keysModal'),
    closeBtn: document.getElementById('keysCloseBtn'),
    saveBtn: document.getElementById('keysSaveBtn'),
    reloadBtn: document.getElementById('keysReloadBtn'),
    status: document.getElementById('keysStatus'),
    envOpenai: document.getElementById('envOpenai'),
    envXai: document.getElementById('envXai'),
    envGemini: document.getElementById('envGemini'),
    envAnthropic: document.getElementById('envAnthropic'),
    showOpenai: document.getElementById('showOpenai'),
    showXai: document.getElementById('showXai'),
    showGemini: document.getElementById('showGemini'),
    showAnthropic: document.getElementById('showAnthropic'),
    backupSelect: document.getElementById('backupSelect'),
    restoreBtn: document.getElementById('restoreBtn'),
  };

  async function uploadPickedFile(file, kind) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const url = '/api/upload?kind=' + encodeURIComponent(String(kind || ''));
    const resp = await fetch(url, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
    if (!data?.path) throw new Error('Upload response missing path');
    return String(data.path);
  }

  function setPickedHint(el, text) {
    if (!el) return;
    el.textContent = text || '';
  }

  function setKeysStatus(msg, kind) {
    if (!keysUi.status) return;
    keysUi.status.textContent = msg || '';
    keysUi.status.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'hint';
  }

  function setPasswordToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.textContent = isPw ? 'Hide' : 'Show';
    });
  }

  async function loadEnvIntoModal() {
    setKeysStatus('Loading...', 'hint');
    const resp = await fetch('/api/env');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
    const k = data?.keys || {};
    if (keysUi.envOpenai) keysUi.envOpenai.value = String(k.OPENAI_API_KEY || '');
    if (keysUi.envXai) keysUi.envXai.value = String(k.XAI_API_KEY || '');
    if (keysUi.envGemini) keysUi.envGemini.value = String(k.GEMINI_API_KEY || '');
    if (keysUi.envAnthropic) keysUi.envAnthropic.value = String(k.ANTHROPIC_API_KEY || '');

    if (keysUi.backupSelect) {
      keysUi.backupSelect.innerHTML = '';
      const backups = Array.isArray(data?.backups) ? data.backups : [];
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = backups.length ? '(select a backup to restore)' : '(no backups yet)';
      keysUi.backupSelect.appendChild(opt0);
      for (const b of backups) {
        const name = String(b?.name || '');
        if (!name) continue;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        keysUi.backupSelect.appendChild(opt);
      }
    }

    setKeysStatus(data?.exists ? 'Loaded from .env' : 'No .env yet (will be created on save)', data?.exists ? 'ok' : 'warn');
  }

  async function saveEnvFromModal() {
    const payload = {
      keys: {
        OPENAI_API_KEY: keysUi.envOpenai ? keysUi.envOpenai.value : '',
        XAI_API_KEY: keysUi.envXai ? keysUi.envXai.value : '',
        GEMINI_API_KEY: keysUi.envGemini ? keysUi.envGemini.value : '',
        ANTHROPIC_API_KEY: keysUi.envAnthropic ? keysUi.envAnthropic.value : '',
      },
    };
    setKeysStatus('Saving...', 'hint');
    const resp = await fetch('/api/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
    setKeysStatus('Saved. Backup created if .env existed.', 'ok');
    // Reload backup list
    await loadEnvIntoModal();
  }

  async function restoreEnvBackup() {
    const name = keysUi.backupSelect ? String(keysUi.backupSelect.value || '') : '';
    if (!name) {
      setKeysStatus('Select a backup first.', 'warn');
      return;
    }
    setKeysStatus('Restoring...', 'hint');
    const resp = await fetch('/api/env/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
    setKeysStatus('Restored backup. Reloaded.', 'ok');
    await loadEnvIntoModal();
  }

  function openKeysModal(focus) {
    if (!keysUi.modal) return;
    keysUi.modal.style.display = 'flex';
    setKeysStatus('', 'hint');
    loadEnvIntoModal().catch((e) => setKeysStatus(String(e?.message || e), 'err'));
    const focusMap = {
      openai: keysUi.envOpenai,
      xai: keysUi.envXai,
      gemini: keysUi.envGemini,
      anthropic: keysUi.envAnthropic,
    };
    const el = focusMap[focus];
    if (el && el.focus) setTimeout(() => el.focus(), 50);
  }

  function closeKeysModal() {
    if (!keysUi.modal) return;
    keysUi.modal.style.display = 'none';
  }

  function getConfig() {
    return {
      questionPath: els.questionPath.value.trim(),
      baselineNetlistPath: els.baselineNetlistPath.value.trim(),
      baselineImagePath: els.baselineImagePath.value.trim(),
      outdir: els.outdir.value.trim(),
      bundleIncludes: Boolean(els.bundleIncludes.checked),
      openaiModel: els.openaiModel.value.trim(),
      grokModel: els.grokModel.value.trim(),
      geminiModel: els.geminiModel.value.trim(),
      claudeModel: els.claudeModel.value.trim(),
    };
  }

  function setConfig(cfg) {
    const c = { ...DEFAULTS, ...(cfg || {}) };
    els.questionPath.value = c.questionPath || "";
    els.baselineNetlistPath.value = c.baselineNetlistPath || "";
    els.baselineImagePath.value = c.baselineImagePath || "";
    els.outdir.value = c.outdir || "runs";
    els.bundleIncludes.checked = Boolean(c.bundleIncludes);
    els.openaiModel.value = c.openaiModel || "";
    els.grokModel.value = c.grokModel || "";
    els.geminiModel.value = c.geminiModel || "";
    els.claudeModel.value = c.claudeModel || "";
  }

  function setStatus(kind, msg) {
    els.status.className = kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : 'hint';
    els.status.textContent = msg;
  }

  function logLine(s) {
    // Note: this JS is embedded inside a server-side template literal, so we must double-escape.
    els.log.textContent += s + "\\n";
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clientLog(s) {
    try {
      logLine('[ui] ' + s);
    } catch {
      // ignore
    }
  }

  window.addEventListener('error', (e) => {
    try {
      const msg = (e && e.message) ? String(e.message) : 'Unknown client error';
      setStatus('err', 'Client JS error: ' + msg);
      clientLog('ERROR: ' + msg);
    } catch {
      // ignore
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      const msg = e && e.reason ? String(e.reason?.message || e.reason) : 'Unhandled rejection';
      setStatus('err', 'Client JS error: ' + msg);
      clientLog('UNHANDLED: ' + msg);
    } catch {
      // ignore
    }
  });

  function clearLog() {
    els.log.textContent = "";
  }

  function quoteCmd(arg) {
    const s = String(arg ?? '');
    if (!s) return '""';
    if (!/[\s"]/g.test(s)) return s;
    return '"' + s.replace(/"/g, '\\"') + '"';
  }

  function quotePs(arg) {
    const s = String(arg ?? '');
    if (!s) return '""';
    if (!/[\s"]/g.test(s)) return s;
    const bt = String.fromCharCode(96);
    return '"' + s.replace(/"/g, bt + '"') + '"';
  }

  function buildArgs(cfg, q) {
    const args = [];
    if (cfg.questionPath) args.push('--question', q(cfg.questionPath));
    if (cfg.baselineNetlistPath) args.push('--baseline-netlist', q(cfg.baselineNetlistPath));
    if (cfg.baselineImagePath) args.push('--baseline-image', q(cfg.baselineImagePath));
    if (cfg.bundleIncludes) args.push('--bundle-includes');
    if (cfg.outdir) args.push('--outdir', q(cfg.outdir));
    if (cfg.openaiModel) args.push('--openai-model', q(cfg.openaiModel));
    if (cfg.grokModel) args.push('--grok-model', q(cfg.grokModel));
    if (cfg.geminiModel) args.push('--gemini-model', q(cfg.geminiModel));
    if (cfg.claudeModel) args.push('--claude-model', q(cfg.claudeModel));
    return args;
  }

  function buildChatArgs(cfg, q) {
    // Chat CLI uses baseline context + models (no --question, no --bundle-includes).
    const args = [];
    if (cfg.baselineNetlistPath) args.push('--baseline-netlist', q(cfg.baselineNetlistPath));
    if (cfg.baselineImagePath) args.push('--baseline-image', q(cfg.baselineImagePath));
    if (cfg.openaiModel) args.push('--openai-model', q(cfg.openaiModel));
    if (cfg.grokModel) args.push('--grok-model', q(cfg.grokModel));
    if (cfg.geminiModel) args.push('--gemini-model', q(cfg.geminiModel));
    if (cfg.claudeModel) args.push('--claude-model', q(cfg.claudeModel));
    return args;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('ok', 'Copied to clipboard.');
    } catch {
      // Fallback for browsers/environments where the Clipboard API is blocked.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-10000px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) {
          setStatus('ok', 'Copied to clipboard.');
          return;
        }
      } catch {
        // ignore
      }
      setStatus('err', 'Clipboard copy failed. Select the text and copy manually.');
    }
  }

  function updateCommandPreview() {
    const cfg = getConfig();
    const fname = (els.configFilename.value || '').trim() || 'ai-schematics.config.json';
    const basePs = ['node', 'dist/index.js', 'run', '--no-prompts'];
    const baseCmd = ['node', 'dist\\index.js', 'run', '--no-prompts'];

    const baseChatPs = ['node', 'dist/index.js', 'chat'];
    const baseChatCmd = ['node', 'dist\\index.js', 'chat'];

    const jsonPs = [...basePs, '--config', quotePs(fname)].join(' ');
    const jsonCmd = [...baseCmd, '--config', quoteCmd(fname)].join(' ');
    const expPs = [...basePs, ...buildArgs(cfg, quotePs)].join(' ');
    const expCmd = [...baseCmd, ...buildArgs(cfg, quoteCmd)].join(' ');

    const chatProvider = String((els.chatProvider && els.chatProvider.value) || 'openai').trim() || 'openai';
    const chatMaxHistory = String((els.chatMaxHistory && els.chatMaxHistory.value) || '10').trim() || '10';
    const chatSave = Boolean(els.chatSave && els.chatSave.checked);
    const chatArgsPs = ['--provider', quotePs(chatProvider), '--max-history', quotePs(chatMaxHistory), ...buildChatArgs(cfg, quotePs)];
    const chatArgsCmd = ['--provider', quoteCmd(chatProvider), '--max-history', quoteCmd(chatMaxHistory), ...buildChatArgs(cfg, quoteCmd)];
    if (chatSave) {
      chatArgsPs.push('--save');
      chatArgsCmd.push('--save');
      if (cfg.outdir) {
        chatArgsPs.push('--outdir', quotePs(cfg.outdir));
        chatArgsCmd.push('--outdir', quoteCmd(cfg.outdir));
      }
    }

    const chatPs = [...baseChatPs, ...chatArgsPs].join(' ');
    const chatCmd = [...baseChatCmd, ...chatArgsCmd].join(' ');

    els.cmdPreview.textContent =
      'Config JSON command:\\n' +
      '  PowerShell: ' + jsonPs + '\\n' +
      '  cmd.exe:    ' + jsonCmd + '\\n\\n' +
      'Explicit-params command:\\n' +
      '  PowerShell: ' + expPs + '\\n' +
      '  cmd.exe:    ' + expCmd + '\n\n' +
      'Interactive chat command:\n' +
      '  PowerShell: ' + chatPs + '\n' +
      '  cmd.exe:    ' + chatCmd;

    // Show a warning if the config references UI-uploaded snapshot paths.
    try {
      const paths = [
        String(cfg.questionPath || ''),
        String(cfg.baselineNetlistPath || ''),
        String(cfg.baselineImagePath || ''),
      ].filter(Boolean);
      const hasUploads = paths.some((p) => {
        const s = String(p).replace(/\\/g, '/').toLowerCase();
        return s.includes('/.ui_uploads/') || s.startsWith('.ui_uploads/') || s.includes('\\.ui_uploads\\') || s.includes('/.ui_uploads\\');
      });
      if (els.uploadSnapshotWarn) els.uploadSnapshotWarn.style.display = hasUploads ? 'block' : 'none';
    } catch {
      if (els.uploadSnapshotWarn) els.uploadSnapshotWarn.style.display = 'none';
    }

    els.copyJsonPsBtn.onclick = () => copyText(jsonPs);
    els.copyJsonCmdBtn.onclick = () => copyText(jsonCmd);
    if (els.copyChatPsBtn) els.copyChatPsBtn.onclick = () => copyText(chatPs);
    if (els.copyChatCmdBtn) els.copyChatCmdBtn.onclick = () => copyText(chatCmd);
  }

  function downloadLink(filePath) {
    const u = new URL('/api/file', window.location.origin);
    u.searchParams.set('path', filePath);
    return u.toString();
  }

  let lastRun = null;

  async function run() {
    clearLog();
    setStatus('hint', 'Running...');
    els.runBtn.disabled = true;
    els.openRunDirBtn.disabled = true;
    els.downloadFinalMdBtn.disabled = true;
    els.downloadFinalCirBtn.disabled = true;
    els.downloadReportBtn.disabled = true;

    try {
      const cfg = getConfig();
      const resp = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));

      lastRun = data;
      setStatus('ok', 'Done. Run folder: ' + data.runDir);
      (data.logs || []).forEach(logLine);

      els.openRunDirBtn.disabled = false;
      els.openRunDirBtn.onclick = async () => {
        await fetch('/api/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: data.runDir }),
        });
      };

      if (data.outputs?.finalMd) {
        els.downloadFinalMdBtn.disabled = false;
        els.downloadFinalMdBtn.onclick = () => window.open(downloadLink(data.outputs.finalMd), '_blank');
      }
      if (data.outputs?.finalCir) {
        els.downloadFinalCirBtn.disabled = false;
        els.downloadFinalCirBtn.onclick = () => window.open(downloadLink(data.outputs.finalCir), '_blank');
      }
      if (data.outputs?.reportDocx) {
        els.downloadReportBtn.disabled = false;
        els.downloadReportBtn.onclick = () => window.open(downloadLink(data.outputs.reportDocx), '_blank');
      }
    } catch (e) {
      setStatus('err', String(e?.message || e));
      logLine(String(e?.stack || e));
    } finally {
      els.runBtn.disabled = false;
    }
  }

  async function pickAndUpload(kind) {
    try {
      let fileEl, pathEl, hintEl;
      if (kind === 'question') {
        fileEl = els.questionFile;
        pathEl = els.questionPath;
        hintEl = els.questionPickedHint;
      } else if (kind === 'baselineNetlist') {
        fileEl = els.baselineNetlistFile;
        pathEl = els.baselineNetlistPath;
        hintEl = els.baselineNetlistPickedHint;
      } else {
        fileEl = els.baselineImageFile;
        pathEl = els.baselineImagePath;
        hintEl = els.baselineImagePickedHint;
      }

      const f = fileEl.files && fileEl.files[0];
      if (!f) return;
      clientLog('Picked file for ' + kind + ': ' + f.name + ' (' + f.size + ' bytes)');
      setStatus('hint', 'Uploading ' + f.name + '...');
      const savedPath = await uploadPickedFile(f, kind);
      pathEl.value = savedPath;
      setPickedHint(hintEl, 'Picked: ' + f.name);
      setStatus('ok', 'Uploaded. (Snapshot — re-upload after edits.)');
      clientLog('Uploaded ' + kind + ' -> ' + savedPath);
      updateCommandPreview();
    } catch (e) {
      setStatus('err', String(e?.message || e));
      clientLog('Upload failed for ' + kind + ': ' + String(e?.message || e));
    }
  }

  function clearPicked(kind) {
    if (kind === 'question') {
      els.questionPath.value = '';
      els.questionFile.value = '';
      setPickedHint(els.questionPickedHint, '');
    } else if (kind === 'baselineNetlist') {
      els.baselineNetlistPath.value = '';
      els.baselineNetlistFile.value = '';
      setPickedHint(els.baselineNetlistPickedHint, '');
    } else {
      els.baselineImagePath.value = '';
      els.baselineImageFile.value = '';
      setPickedHint(els.baselineImagePickedHint, '');
    }
    clientLog('Cleared ' + kind);
    updateCommandPreview();
  }

  function saveLocal() {
    try {
      localStorage.setItem('ai-schematics-ensemble-ui-config', JSON.stringify(getConfig(), null, 2));
      setStatus('ok', 'Saved config to localStorage.');
    } catch (e) {
      setStatus('err', 'Save failed (localStorage blocked): ' + String(e?.message || e));
    }
  }

  function loadLocal() {
    let raw = '';
    try {
      raw = localStorage.getItem('ai-schematics-ensemble-ui-config') || '';
    } catch (e) {
      setStatus('err', 'Load failed (localStorage blocked): ' + String(e?.message || e));
      return;
    }
    if (!raw) {
      setStatus('warn', 'No saved config found.');
      return;
    }
    try {
      setConfig(JSON.parse(raw));
      setStatus('ok', 'Loaded saved config.');
    } catch (e) {
      setStatus('err', 'Failed to parse saved config: ' + String(e?.message || e));
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(getConfig(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const fname = (els.configFilename?.value || '').trim() || 'ai-schematics.config.json';
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    updateCommandPreview();
  }

  async function importJson(file) {
    const text = await file.text();
    const cfg = JSON.parse(text);
    setConfig(cfg);
    setStatus('ok', 'Imported config JSON.');
  }

  function clearSaved() {
    try {
      localStorage.removeItem('ai-schematics-ensemble-ui-config');
      setStatus('ok', 'Cleared saved config.');
    } catch (e) {
      setStatus('err', 'Clear failed (localStorage blocked): ' + String(e?.message || e));
    }
  }

  function on(el, evt, fn) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(evt, fn);
  }

  on(els.runBtn, 'click', run);

  // API key buttons
  on(els.openaiKeyBtn, 'click', () => openKeysModal('openai'));
  on(els.xaiKeyBtn, 'click', () => openKeysModal('xai'));
  on(els.geminiKeyBtn, 'click', () => openKeysModal('gemini'));
  on(els.anthropicKeyBtn, 'click', () => openKeysModal('anthropic'));

  on(keysUi.closeBtn, 'click', closeKeysModal);
  on(keysUi.modal, 'click', (e) => {
    if (e && e.target === keysUi.modal) closeKeysModal();
  });
  on(keysUi.reloadBtn, 'click', () => loadEnvIntoModal().catch((e) => setKeysStatus(String(e?.message || e), 'err')));
  on(keysUi.saveBtn, 'click', () => saveEnvFromModal().catch((e) => setKeysStatus(String(e?.message || e), 'err')));
  on(keysUi.restoreBtn, 'click', () => restoreEnvBackup().catch((e) => setKeysStatus(String(e?.message || e), 'err')));

  setPasswordToggle(keysUi.showOpenai, keysUi.envOpenai);
  setPasswordToggle(keysUi.showXai, keysUi.envXai);
  setPasswordToggle(keysUi.showGemini, keysUi.envGemini);
  setPasswordToggle(keysUi.showAnthropic, keysUi.envAnthropic);

  // Browse buttons (upload to server, then fill path)
  // Note: browse is handled by <label for="...">; change events below trigger upload.

  on(els.questionFile, 'change', () => pickAndUpload('question'));
  on(els.baselineNetlistFile, 'change', () => pickAndUpload('baselineNetlist'));
  on(els.baselineImageFile, 'change', () => pickAndUpload('baselineImage'));

  on(els.questionClearBtn, 'click', () => clearPicked('question'));
  on(els.baselineNetlistClearBtn, 'click', () => clearPicked('baselineNetlist'));
  on(els.baselineImageClearBtn, 'click', () => clearPicked('baselineImage'));
  on(els.saveConfigBtn, 'click', saveLocal);
  on(els.loadConfigBtn, 'click', loadLocal);
  on(els.exportConfigBtn, 'click', exportJson);
  on(els.clearSavedBtn, 'click', clearSaved);
  on(els.importConfigInput, 'change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJson(f);
  });

  on(els.updateCmdBtn, 'click', updateCommandPreview);

  // Keep preview in sync as user edits
  for (const id of ['questionPath','baselineNetlistPath','baselineImagePath','outdir','bundleIncludes','openaiModel','grokModel','geminiModel','claudeModel','configFilename','chatProvider','chatMaxHistory','chatSave']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => updateCommandPreview());
    el.addEventListener('change', () => updateCommandPreview());
  }

  setConfig(DEFAULTS);
  updateCommandPreview();
  setStatus('hint', 'Ready.');
  clientLog('Client JS initialized.');

  });
</script>

<div id="keysModal" style="position:fixed; inset:0; display:none; align-items:center; justify-content:center; background: rgba(0,0,0,.55); padding: 16px;">
  <div style="width:min(780px, 100%); background: rgba(20,20,20,.92); border:1px solid rgba(127,127,127,.35); border-radius: 14px; padding: 14px;">
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap: 12px;">
      <div style="font-weight:700;">API Keys (.env)</div>
      <button type="button" id="keysCloseBtn" title="Close" style="padding: 8px 10px;">✕</button>
    </div>
    <div class="hint" style="margin: 6px 0 12px;">These values are read from and written to <span class="mono">.env</span> on this machine.</div>

    <div class="row"><label>OPENAI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envOpenai" type="password" placeholder="(optional)" /><button type="button" id="showOpenai">Show</button></div></div>
    <div class="row"><label>XAI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envXai" type="password" placeholder="(optional)" /><button type="button" id="showXai">Show</button></div></div>
    <div class="row"><label>GEMINI_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envGemini" type="password" placeholder="(optional)" /><button type="button" id="showGemini">Show</button></div></div>
    <div class="row"><label>ANTHROPIC_API_KEY</label><div style="display:flex; gap:8px; align-items:center;"><input id="envAnthropic" type="password" placeholder="(optional)" /><button type="button" id="showAnthropic">Show</button></div></div>

    <div class="actions" style="margin-top: 12px;">
      <button type="button" class="primary" id="keysSaveBtn">Save .env</button>
      <button type="button" id="keysReloadBtn">Reload</button>
      <span class="hint" id="keysStatus" style="align-self:center;"></span>
    </div>

    <div style="margin-top: 14px;">
      <div style="font-weight:700; margin-bottom: 6px;">Backups</div>
      <div class="hint" style="margin-bottom: 6px;">If a key is accidentally deleted, restore a previous .env backup.</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <select id="backupSelect" style="min-width: 380px; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.06);"></select>
        <button type="button" id="restoreBtn">Restore selected</button>
      </div>
    </div>
  </div>
</div>

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

      if (method === "POST" && pathname === "/api/upload") {
        try {
          const contentType = String(req.headers["content-type"] ?? "");
          const u = new URL(req.url || "/api/upload", `http://${String(req.headers.host ?? "localhost")}`);
          const kind = getSingleQueryParam(u, "kind");
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
                originalFilename: received.filename,
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

          const safe = sanitizeFileName(requested);
          const body = await readRequestBody(req);
          if (!body || body.length === 0) {
            sendJson(res, 400, { error: "Empty body" });
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

        const runOpts: RunBatchOptions = {
          questionPath: String(payload.questionPath ?? ""),
          baselineNetlistPath: payload.baselineNetlistPath ? String(payload.baselineNetlistPath) : undefined,
          baselineImagePath: payload.baselineImagePath ? String(payload.baselineImagePath) : undefined,
          bundleIncludes: Boolean(payload.bundleIncludes),
          outdir: payload.outdir ? String(payload.outdir) : defaultOutdir,
          openaiModel: payload.openaiModel ? String(payload.openaiModel) : undefined,
          grokModel: payload.grokModel ? String(payload.grokModel) : undefined,
          geminiModel: payload.geminiModel ? String(payload.geminiModel) : undefined,
          claudeModel: payload.claudeModel ? String(payload.claudeModel) : undefined,
          allowPrompts: false,
        };

        if (!runOpts.questionPath.trim()) {
          sendJson(res, 400, { error: "questionPath is required" });
          return;
        }

        const logs: string[] = [];
        const logger: RunBatchLogger = {
          info: (m) => logs.push(m),
          warn: (m) => logs.push("WARN: " + m),
          error: (m) => logs.push("ERROR: " + m),
        };

        let result: RunBatchResult;
        try {
          result = await runBatch(runOpts, logger);
        } catch (e: any) {
          sendJson(res, 500, { error: String(e?.message ?? e), logs });
          return;
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

        try {
          if (process.platform === "win32") {
            await execa("explorer.exe", [abs]);
          } else if (process.platform === "darwin") {
            await execa("open", [abs]);
          } else {
            await execa("xdg-open", [abs]);
          }
          sendJson(res, 200, { ok: true });
        } catch (e: any) {
          sendJson(res, 500, { error: String(e?.message ?? e) });
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
                      : "application/octet-stream";

        res.writeHead(200, {
          "content-type": ct,
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${path.basename(abs)}"`,
        });

        fs.createReadStream(abs).pipe(res);
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
