type Provider = "openai" | "xai" | "google" | "anthropic";

type UiDefaults = {
  questionPath?: string;
  baselineNetlistPath?: string;
  baselineImagePath?: string;
  outdir?: string;
  schematicDpi?: number;
  bundleIncludes?: boolean;
  openaiModel?: string;
  grokModel?: string;
  geminiModel?: string;
  claudeModel?: string;
  enabledProviders?: Provider[];
};

type UiInit = {
  cwd: string;
  defaults: UiDefaults;
};

type UploadKind = "question" | "baselineNetlist" | "baselineImage" | "include";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function textOf(el: HTMLElement | null, t: string) {
  if (el) el.textContent = t;
}

function setStatus(kind: "ok" | "warn" | "err" | "hint", msg: string) {
  const status = byId<HTMLDivElement>("status");
  if (!status) return;
  status.className = kind;
  status.textContent = msg;
}

function logLine(s: string) {
  const log = byId<HTMLPreElement>("log");
  if (!log) return;
  log.textContent += s + "\n";
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  const log = byId<HTMLPreElement>("log");
  if (!log) return;
  log.textContent = "";
}

function needsQuoting(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '"' || code <= 32) return true;
  }
  return false;
}

function quoteCmd(arg: unknown): string {
  const s = String(arg ?? "");
  if (!s) return '""';
  if (!needsQuoting(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function quotePs(arg: unknown): string {
  const s = String(arg ?? "");
  if (!s) return '""';
  if (!needsQuoting(s)) return s;
  const bt = String.fromCharCode(96);
  return '"' + s.replace(/"/g, bt + '"') + '"';
}

function basenameAny(p: unknown): string {
  const s = String(p ?? "");
  const parts = s.split(/[\\/]+/g).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function setPickedHint(id: string, msg: string) {
  textOf(byId(id), msg);
}

function setPathBox(pathId: string, displayValue: string, actualValue?: string) {
  const el = byId<HTMLInputElement>(pathId);
  if (!el) return;
  el.readOnly = true;
  el.classList.add("subduedPath");
  el.value = displayValue || "";
  if (actualValue) el.dataset.uploadedPath = actualValue;
  else delete el.dataset.uploadedPath;
}

function getEffectivePath(pathId: string): string {
  const el = byId<HTMLInputElement>(pathId);
  if (!el) return "";
  const up = el.dataset && el.dataset.uploadedPath ? String(el.dataset.uploadedPath || "") : "";
  return (up || el.value || "").trim();
}

async function uploadPickedFile(file: File, kind: UploadKind): Promise<{ path: string; filename?: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const url = "/api/upload?kind=" + encodeURIComponent(kind);
  const resp = await fetch(url, { method: "POST", body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(String((data as any)?.error || ("HTTP " + resp.status)));
  if (!(data as any)?.path) throw new Error("Upload response missing path");
  return { path: String((data as any).path), filename: (data as any).filename ? String((data as any).filename) : undefined };
}

const API_KEYS_STORAGE_KEY = "ai-schematics-ensemble-ui-api-keys";

type ApiKeys = Partial<Record<"OPENAI_API_KEY" | "XAI_API_KEY" | "GEMINI_API_KEY" | "ANTHROPIC_API_KEY", string>>;

function loadApiKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(API_KEYS_STORAGE_KEY) || "";
    if (!raw) return {};
    const parsed: any = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ApiKeys = {};
    if (typeof parsed.OPENAI_API_KEY === "string") out.OPENAI_API_KEY = parsed.OPENAI_API_KEY;
    if (typeof parsed.XAI_API_KEY === "string") out.XAI_API_KEY = parsed.XAI_API_KEY;
    if (typeof parsed.GEMINI_API_KEY === "string") out.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (typeof parsed.ANTHROPIC_API_KEY === "string") out.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    return out;
  } catch {
    return {};
  }
}

function saveApiKeys(keys: ApiKeys): boolean {
  try {
    localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
}

function setKeysStatus(msg: string, kind: "ok" | "err" | "hint" = "hint") {
  const el = byId<HTMLSpanElement>("keysStatus");
  if (!el) return;
  el.className = kind;
  el.textContent = msg;
}

function openKeysModal(focus?: "openai" | "xai" | "gemini" | "anthropic") {
  const modal = byId<HTMLDivElement>("keysModal");
  if (!modal) return;

  modal.style.display = "flex";

  const keys = loadApiKeys();
  const envOpenai = byId<HTMLInputElement>("envOpenai");
  const envXai = byId<HTMLInputElement>("envXai");
  const envGemini = byId<HTMLInputElement>("envGemini");
  const envAnthropic = byId<HTMLInputElement>("envAnthropic");
  if (envOpenai) envOpenai.value = String(keys.OPENAI_API_KEY || "");
  if (envXai) envXai.value = String(keys.XAI_API_KEY || "");
  if (envGemini) envGemini.value = String(keys.GEMINI_API_KEY || "");
  if (envAnthropic) envAnthropic.value = String(keys.ANTHROPIC_API_KEY || "");

  setKeysStatus("", "hint");

  const focusMap: Record<string, HTMLInputElement | null> = {
    openai: envOpenai,
    xai: envXai,
    gemini: envGemini,
    anthropic: envAnthropic,
  };
  const el = focus ? focusMap[focus] : null;
  if (el && el.focus) setTimeout(() => el.focus(), 50);
}

function getApiKeysForRun(): ApiKeys {
  const keys = loadApiKeys();
  const out: ApiKeys = {};
  for (const k of ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    const v = String((keys as any)[k] || "").trim();
    if (v) (out as any)[k] = v;
  }
  return out;
}

function closeKeysModal() {
  const modal = byId<HTMLDivElement>("keysModal");
  if (!modal) return;
  modal.style.display = "none";
}

function setPasswordToggle(btnId: string, inputId: string) {
  const btn = byId<HTMLButtonElement>(btnId);
  const input = byId<HTMLInputElement>(inputId);
  if (!btn || !input) return;
  btn.addEventListener("click", () => {
    const isPw = input.type === "password";
    input.type = isPw ? "text" : "password";
    btn.textContent = isPw ? "Hide" : "Show";
  });
}

function getConfigFromUi() {
  const dpiRaw = String(byId<HTMLInputElement>("schematicDpi")?.value ?? "").trim();
  const dpi = dpiRaw ? Number.parseInt(dpiRaw, 10) : NaN;

  const bundleIncludes = String(byId<HTMLSelectElement>("bundleIncludes")?.value ?? "false").trim().toLowerCase() === "true";

  const enabledProviders: Provider[] = [];
  if (byId<HTMLInputElement>("useOpenai")?.checked) enabledProviders.push("openai");
  if (byId<HTMLInputElement>("useXai")?.checked) enabledProviders.push("xai");
  if (byId<HTMLInputElement>("useGemini")?.checked) enabledProviders.push("google");
  if (byId<HTMLInputElement>("useAnthropic")?.checked) enabledProviders.push("anthropic");

  return {
    questionPath: getEffectivePath("questionPath"),
    baselineNetlistPath: getEffectivePath("baselineNetlistPath"),
    baselineImagePath: getEffectivePath("baselineImagePath"),
    outdir: String(byId<HTMLInputElement>("outdir")?.value ?? "").trim(),
    schematicDpi: Number.isFinite(dpi) && dpi > 0 ? dpi : undefined,
    bundleIncludes,
    openaiModel: String(byId<HTMLInputElement>("openaiModel")?.value ?? "").trim(),
    grokModel: String(byId<HTMLInputElement>("grokModel")?.value ?? "").trim(),
    geminiModel: String(byId<HTMLInputElement>("geminiModel")?.value ?? "").trim(),
    claudeModel: String(byId<HTMLInputElement>("claudeModel")?.value ?? "").trim(),
    enabledProviders,
  };
}

function buildArgs(cfg: any, q: (v: unknown) => string) {
  const args: string[] = [];
  const enabled: string[] = Array.isArray(cfg.enabledProviders) && cfg.enabledProviders.length
    ? cfg.enabledProviders.map((p: any) => String(p || "").trim().toLowerCase())
    : ["openai", "xai", "google", "anthropic"];

  if (cfg.questionPath) args.push("--question", q(cfg.questionPath));
  if (cfg.baselineNetlistPath) args.push("--baseline-netlist", q(cfg.baselineNetlistPath));
  if (cfg.baselineImagePath) args.push("--baseline-image", q(cfg.baselineImagePath));
  if (cfg.bundleIncludes) args.push("--bundle-includes");
  if (cfg.outdir) args.push("--outdir", q(cfg.outdir));
  if (cfg.schematicDpi) args.push("--schematic-dpi", q(cfg.schematicDpi));

  if (enabled.includes("openai") && cfg.openaiModel) args.push("--openai-model", q(cfg.openaiModel));
  if (enabled.includes("xai") && cfg.grokModel) args.push("--grok-model", q(cfg.grokModel));
  if (enabled.includes("google") && cfg.geminiModel) args.push("--gemini-model", q(cfg.geminiModel));
  if (enabled.includes("anthropic") && cfg.claudeModel) args.push("--claude-model", q(cfg.claudeModel));

  return args;
}

function buildChatArgs(cfg: any, q: (v: unknown) => string) {
  const args: string[] = [];
  const enabled: string[] = Array.isArray(cfg.enabledProviders) && cfg.enabledProviders.length
    ? cfg.enabledProviders.map((p: any) => String(p || "").trim().toLowerCase())
    : ["openai", "xai", "google", "anthropic"];

  if (cfg.baselineNetlistPath) args.push("--baseline-netlist", q(cfg.baselineNetlistPath));
  if (cfg.baselineImagePath) args.push("--baseline-image", q(cfg.baselineImagePath));

  if (enabled.includes("openai") && cfg.openaiModel) args.push("--openai-model", q(cfg.openaiModel));
  if (enabled.includes("xai") && cfg.grokModel) args.push("--grok-model", q(cfg.grokModel));
  if (enabled.includes("google") && cfg.geminiModel) args.push("--gemini-model", q(cfg.geminiModel));
  if (enabled.includes("anthropic") && cfg.claudeModel) args.push("--claude-model", q(cfg.claudeModel));

  return args;
}

function updateCommandPreview() {
  const cfg = getConfigFromUi();

  // Upload snapshot warning (online page uploads are snapshots)
  try {
    const paths = [String(cfg.questionPath || ""), String(cfg.baselineNetlistPath || ""), String(cfg.baselineImagePath || "")].filter(Boolean);
    const hasUploads = paths.some((p) => {
      const s = String(p).split("\\").join("/").toLowerCase();
      return s.includes("/.ui_uploads/") || s.startsWith(".ui_uploads/");
    });
    const warn = byId<HTMLDivElement>("uploadSnapshotWarn");
    if (warn) warn.style.display = hasUploads ? "block" : "none";
  } catch {
    const warn = byId<HTMLDivElement>("uploadSnapshotWarn");
    if (warn) warn.style.display = "none";
  }
}

let includeUploads: Array<{ name: string; path: string }> = [];

function renderIncludeUploads() {
  const names = includeUploads.map((x) => String(x?.name || "")).filter(Boolean);
  const summary = byId<HTMLInputElement>("includeSummary");
  if (summary) summary.value = names.length ? `${names.length} file(s) uploaded` : "";
  const list = byId<HTMLDivElement>("includeFilesList");
  if (list) list.textContent = names.length ? ("Includes: " + names.join(", ")) : "";
}

function clearIncludeUploads() {
  includeUploads = [];
  const el = byId<HTMLInputElement>("includeFiles");
  if (el) el.value = "";
  renderIncludeUploads();
  updateCommandPreview();
}

async function pickAndUpload(kind: Exclude<UploadKind, "include">) {
  try {
    const fileId = kind === "question" ? "questionFile" : kind === "baselineNetlist" ? "baselineNetlistFile" : "baselineImageFile";
    const pathId = kind === "question" ? "questionPath" : kind === "baselineNetlist" ? "baselineNetlistPath" : "baselineImagePath";
    const hintId = kind === "question" ? "questionPickedHint" : kind === "baselineNetlist" ? "baselineNetlistPickedHint" : "baselineImagePickedHint";

    const fileEl = byId<HTMLInputElement>(fileId);
    const f = fileEl?.files && fileEl.files[0];
    if (!f) return;

    setPathBox(pathId, f.name);
    setPickedHint(hintId, "Picked: " + f.name);

    setStatus("hint", "Uploading " + f.name + "...");
    const saved = await uploadPickedFile(f, kind);
    setPathBox(pathId, f.name, saved.path);
    setPickedHint(hintId, "Picked: " + f.name + " (uploaded)");

    setStatus("ok", "Uploaded. (Snapshot — re-upload after edits.)");
    updateCommandPreview();
  } catch (e: any) {
    setStatus("warn", "Upload failed: " + String(e?.message || e));
    updateCommandPreview();
  }
}

async function pickAndUploadIncludes() {
  try {
    const input = byId<HTMLInputElement>("includeFiles");
    const files = input?.files ? Array.from(input.files) : [];
    if (!files.length) return;

    setStatus("hint", "Uploading include files...");
    const uploaded: Array<{ name: string; path: string }> = [];
    for (const f of files) {
      const saved = await uploadPickedFile(f, "include");
      uploaded.push({ name: f.name, path: saved.path });
    }

    includeUploads = uploaded;
    renderIncludeUploads();
    setStatus("ok", `Uploaded ${uploaded.length} include file(s).`);
    updateCommandPreview();
  } catch (e: any) {
    setStatus("err", String(e?.message || e));
  }
}

function clearPicked(kind: "question" | "baselineNetlist" | "baselineImage") {
  const fileId = kind === "question" ? "questionFile" : kind === "baselineNetlist" ? "baselineNetlistFile" : "baselineImageFile";
  const pathId = kind === "question" ? "questionPath" : kind === "baselineNetlist" ? "baselineNetlistPath" : "baselineImagePath";
  const hintId = kind === "question" ? "questionPickedHint" : kind === "baselineNetlist" ? "baselineNetlistPickedHint" : "baselineImagePickedHint";

  setPathBox(pathId, "", "");
  const f = byId<HTMLInputElement>(fileId);
  if (f) f.value = "";
  setPickedHint(hintId, "");
  updateCommandPreview();
}

function setConfig(cfg: UiDefaults) {
  const enabled = Array.isArray(cfg.enabledProviders) && cfg.enabledProviders.length
    ? cfg.enabledProviders
    : (["openai", "xai", "google", "anthropic"] as Provider[]);

  const qPath = cfg.questionPath || "";
  const bnPath = cfg.baselineNetlistPath || "";
  const biPath = cfg.baselineImagePath || "";

  setPathBox("questionPath", basenameAny(qPath), qPath || undefined);
  setPathBox("baselineNetlistPath", basenameAny(bnPath), bnPath || undefined);
  setPathBox("baselineImagePath", basenameAny(biPath), biPath || undefined);

  const outdir = byId<HTMLInputElement>("outdir");
  if (outdir) outdir.value = String(cfg.outdir || "runs");

  const dpi = byId<HTMLInputElement>("schematicDpi");
  if (dpi) dpi.value = cfg.schematicDpi != null && String(cfg.schematicDpi).trim() !== "" ? String(cfg.schematicDpi) : "";

  const bundle = byId<HTMLSelectElement>("bundleIncludes");
  if (bundle) bundle.value = String(Boolean(cfg.bundleIncludes));

  const useOpenai = byId<HTMLInputElement>("useOpenai");
  const useXai = byId<HTMLInputElement>("useXai");
  const useGemini = byId<HTMLInputElement>("useGemini");
  const useAnthropic = byId<HTMLInputElement>("useAnthropic");

  if (useOpenai) useOpenai.checked = enabled.includes("openai");
  if (useXai) useXai.checked = enabled.includes("xai");
  if (useGemini) useGemini.checked = enabled.includes("google");
  if (useAnthropic) useAnthropic.checked = enabled.includes("anthropic");

  const openaiModel = byId<HTMLInputElement>("openaiModel");
  const grokModel = byId<HTMLInputElement>("grokModel");
  const geminiModel = byId<HTMLInputElement>("geminiModel");
  const claudeModel = byId<HTMLInputElement>("claudeModel");

  if (openaiModel) openaiModel.value = String(cfg.openaiModel || "");
  if (grokModel) grokModel.value = String(cfg.grokModel || "");
  if (geminiModel) geminiModel.value = String(cfg.geminiModel || "");
  if (claudeModel) claudeModel.value = String(cfg.claudeModel || "");
}

async function run() {
  clearLog();
  setStatus("hint", "Running...");

  const runBtn = byId<HTMLButtonElement>("runBtn");
  const openRunDirBtn = byId<HTMLButtonElement>("openRunDirBtn");
  const downloadFinalMdBtn = byId<HTMLButtonElement>("downloadFinalMdBtn");
  const downloadFinalCirBtn = byId<HTMLButtonElement>("downloadFinalCirBtn");
  const downloadSchematicPngBtn = byId<HTMLButtonElement>("downloadSchematicPngBtn");
  const viewSchematicPngBtn = byId<HTMLButtonElement>("viewSchematicPngBtn");
  const downloadAnswersMdBtn = byId<HTMLButtonElement>("downloadAnswersMdBtn");
  const downloadReportBtn = byId<HTMLButtonElement>("downloadReportBtn");
  const downloadReportPdfBtn = byId<HTMLButtonElement>("downloadReportPdfBtn");

  if (runBtn) runBtn.disabled = true;
  if (openRunDirBtn) openRunDirBtn.disabled = true;
  if (downloadFinalMdBtn) downloadFinalMdBtn.disabled = true;
  if (downloadFinalCirBtn) downloadFinalCirBtn.disabled = true;
  if (downloadSchematicPngBtn) downloadSchematicPngBtn.disabled = true;
  if (viewSchematicPngBtn) viewSchematicPngBtn.disabled = true;
  if (downloadAnswersMdBtn) downloadAnswersMdBtn.disabled = true;
  if (downloadReportBtn) downloadReportBtn.disabled = true;
  if (downloadReportPdfBtn) downloadReportPdfBtn.disabled = true;

  try {
    const cfg = getConfigFromUi();
    const apiKeys = getApiKeysForRun();

    const resp = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cfg, apiKeys }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(String((data as any)?.error || ("HTTP " + resp.status)));

    setStatus("ok", "Done. Run folder: " + String((data as any).runDir || ""));
    ((data as any).logs || []).forEach((l: any) => logLine(String(l)));

    if (openRunDirBtn) {
      openRunDirBtn.disabled = false;
      openRunDirBtn.onclick = async () => {
        try {
          const runDir = String((data as any).runDir || "");
          if (!runDir) throw new Error("Run directory is missing; cannot open folder.");

          setStatus("hint", "Opening run folder...");

          const r = await fetch("/api/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: runDir }),
          });

          const payload = await r.json().catch(() => ({} as any));
          if (!r.ok) throw new Error(String((payload as any)?.error || ("HTTP " + r.status)));

          const openedWith = String((payload as any)?.openedWith || "").trim();
          const openedArgs = Array.isArray((payload as any)?.openedArgs) ? (payload as any).openedArgs : undefined;
          if (openedWith) {
            setStatus("ok", `Opened run folder (on server machine) via ${openedWith}.`);
            if (openedArgs?.length) logLine(`open: ${openedWith} ${openedArgs.join(" ")}`);
          } else {
            setStatus("ok", "Opened run folder (on server machine).");
          }
        } catch (e: any) {
          setStatus("err", "Open run folder failed: " + String(e?.message || e));
          logLine(String(e?.stack || e));
        }
      };
    }

    const downloadLink = (p: string) => {
      const u = new URL("/api/file", window.location.origin);
      u.searchParams.set("path", p);
      return u.toString();
    };

    const viewLink = (p: string) => {
      const u = new URL("/api/view", window.location.origin);
      u.searchParams.set("path", p);
      return u.toString();
    };

    const answersMdZipLink = (runDir: string) => {
      const u = new URL("/api/answers-md", window.location.origin);
      u.searchParams.set("runDir", runDir);
      return u.toString();
    };

    if ((data as any).outputs?.finalMd && downloadFinalMdBtn) {
      downloadFinalMdBtn.disabled = false;
      downloadFinalMdBtn.onclick = () => window.open(downloadLink(String((data as any).outputs.finalMd)), "_blank");
    }
    if ((data as any).outputs?.finalCir && downloadFinalCirBtn) {
      downloadFinalCirBtn.disabled = false;
      downloadFinalCirBtn.onclick = () => window.open(downloadLink(String((data as any).outputs.finalCir)), "_blank");
    }

    if ((data as any).outputs?.schematicPng && downloadSchematicPngBtn) {
      downloadSchematicPngBtn.disabled = false;
      downloadSchematicPngBtn.onclick = () => window.open(downloadLink(String((data as any).outputs.schematicPng)), "_blank");
    }

    if ((data as any).outputs?.schematicPng && viewSchematicPngBtn) {
      viewSchematicPngBtn.disabled = false;
      viewSchematicPngBtn.onclick = () => window.open(viewLink(String((data as any).outputs.schematicPng)), "_blank");
    }

    if ((data as any).runDir && downloadAnswersMdBtn) {
      downloadAnswersMdBtn.disabled = false;
      downloadAnswersMdBtn.onclick = () => window.open(answersMdZipLink(String((data as any).runDir)), "_blank");
    }

    if ((data as any).outputs?.reportDocx && downloadReportBtn) {
      downloadReportBtn.disabled = false;
      downloadReportBtn.onclick = () => window.open(downloadLink(String((data as any).outputs.reportDocx)), "_blank");
    }

    if ((data as any).outputs?.reportPdf && downloadReportPdfBtn) {
      downloadReportPdfBtn.disabled = false;
      downloadReportPdfBtn.onclick = () => window.open(downloadLink(String((data as any).outputs.reportPdf)), "_blank");
    }
  } catch (e: any) {
    setStatus("err", String(e?.message || e));
    logLine(String(e?.stack || e));
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

function wireEvents(defaults: UiDefaults) {
  const on = (id: string, evt: string, fn: (ev: any) => void) => {
    const el = byId(id);
    if (!el) return;
    el.addEventListener(evt, fn as any);
  };

  on("runBtn", "click", () => void run());

  // API key buttons
  on("keysOpenBtn", "click", () => openKeysModal());
  on("openaiKeyBtn", "click", () => openKeysModal("openai"));
  on("xaiKeyBtn", "click", () => openKeysModal("xai"));
  on("geminiKeyBtn", "click", () => openKeysModal("gemini"));
  on("anthropicKeyBtn", "click", () => openKeysModal("anthropic"));
  on("keysCloseBtn", "click", () => closeKeysModal());
  const modal = byId("keysModal");
  if (modal) {
    modal.addEventListener("click", (e: any) => {
      if (e && e.target === modal) closeKeysModal();
    });
  }
  on("keysSaveBtn", "click", () => {
    const envOpenai = byId<HTMLInputElement>("envOpenai");
    const envXai = byId<HTMLInputElement>("envXai");
    const envGemini = byId<HTMLInputElement>("envGemini");
    const envAnthropic = byId<HTMLInputElement>("envAnthropic");
    const keys: ApiKeys = {
      OPENAI_API_KEY: envOpenai ? String(envOpenai.value || "") : "",
      XAI_API_KEY: envXai ? String(envXai.value || "") : "",
      GEMINI_API_KEY: envGemini ? String(envGemini.value || "") : "",
      ANTHROPIC_API_KEY: envAnthropic ? String(envAnthropic.value || "") : "",
    };
    const ok = saveApiKeys(keys);
    setKeysStatus(ok ? "Saved to localStorage." : "Save failed (localStorage blocked).", ok ? "ok" : "err");
  });

  setPasswordToggle("showOpenai", "envOpenai");
  setPasswordToggle("showXai", "envXai");
  setPasswordToggle("showGemini", "envGemini");
  setPasswordToggle("showAnthropic", "envAnthropic");

  // Clear file inputs before browse so selecting same file triggers events
  on("questionBrowseBtn", "click", () => { const el = byId<HTMLInputElement>("questionFile"); if (el) el.value = ""; });
  on("baselineNetlistBrowseBtn", "click", () => { const el = byId<HTMLInputElement>("baselineNetlistFile"); if (el) el.value = ""; });
  on("baselineImageBrowseBtn", "click", () => { const el = byId<HTMLInputElement>("baselineImageFile"); if (el) el.value = ""; });
  on("includeBrowseBtn", "click", () => { const el = byId<HTMLInputElement>("includeFiles"); if (el) el.value = ""; });

  on("questionFile", "change", () => void pickAndUpload("question"));
  on("baselineNetlistFile", "change", () => void pickAndUpload("baselineNetlist"));
  on("baselineImageFile", "change", () => void pickAndUpload("baselineImage"));
  on("includeFiles", "change", () => void pickAndUploadIncludes());

  on("questionClearBtn", "click", () => clearPicked("question"));
  on("baselineNetlistClearBtn", "click", () => clearPicked("baselineNetlist"));
  on("baselineImageClearBtn", "click", () => clearPicked("baselineImage"));
  on("includeClearBtn", "click", () => clearIncludeUploads());

  // Local save/load/export/import
  on("saveConfigBtn", "click", () => {
    try {
      localStorage.setItem("ai-schematics-ensemble-ui-config", JSON.stringify(getConfigFromUi(), null, 2));
      setStatus("ok", "Saved config to localStorage.");
    } catch (e: any) {
      setStatus("err", "Save failed (localStorage blocked): " + String(e?.message || e));
    }
  });

  on("loadConfigBtn", "click", () => {
    try {
      const raw = localStorage.getItem("ai-schematics-ensemble-ui-config") || "";
      if (!raw) {
        setStatus("warn", "No saved config found.");
        return;
      }
      setConfig(JSON.parse(raw));
      setStatus("ok", "Loaded saved config.");
      updateCommandPreview();
    } catch (e: any) {
      setStatus("err", "Load failed: " + String(e?.message || e));
    }
  });

  on("exportConfigBtn", "click", () => {
    const blob = new Blob([JSON.stringify(getConfigFromUi(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ai-schematics.config.json";
    a.click();
    URL.revokeObjectURL(a.href);
    updateCommandPreview();
  });

  on("clearSavedBtn", "click", () => {
    try {
      localStorage.removeItem("ai-schematics-ensemble-ui-config");
      setStatus("ok", "Cleared saved config.");
    } catch (e: any) {
      setStatus("err", "Clear failed: " + String(e?.message || e));
    }
  });

  const importInput = byId<HTMLInputElement>("importConfigInput");
  if (importInput) {
    importInput.addEventListener("change", async (e: any) => {
      const f: File | undefined = e?.target?.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        setConfig(JSON.parse(text));
        setStatus("ok", "Imported config JSON.");
        updateCommandPreview();
      } catch (err: any) {
        setStatus("err", "Import failed: " + String(err?.message || err));
      }
    });
  }

  // Keep preview in sync
  for (const id of [
    "questionPath",
    "baselineNetlistPath",
    "baselineImagePath",
    "outdir",
    "schematicDpi",
    "bundleIncludes",
    "useOpenai",
    "useXai",
    "useGemini",
    "useAnthropic",
    "openaiModel",
    "grokModel",
    "geminiModel",
    "claudeModel",
  ]) {
    on(id, "input", () => updateCommandPreview());
    on(id, "change", () => updateCommandPreview());
  }

  // Init
  setConfig(defaults);
  updateCommandPreview();
  setStatus("hint", "Ready.");
  logLine("[ui] Client JS initialized.");
}

function liveReload() {
  try {
    const es = new EventSource("/api/dev/events");
    es.addEventListener("instance", (ev: any) => {
      const id = String(ev?.data || "");
      if (!id) return;
      const key = "aiSchematicsUiInstanceId";
      const prev = sessionStorage.getItem(key);
      sessionStorage.setItem(key, id);
      if (prev && prev !== id) location.reload();
    });
  } catch {
    // ignore
  }
}

window.addEventListener("DOMContentLoaded", () => {
  liveReload();

  const initEl = byId<HTMLScriptElement>("uiInit");
  const initText = initEl?.textContent || "";
  if (!initText.trim()) {
    setStatus("err", "UI init missing.");
    return;
  }

  let init: UiInit;
  try {
    init = JSON.parse(initText) as UiInit;
  } catch (e: any) {
    setStatus("err", "UI init parse failed: " + String(e?.message || e));
    return;
  }

  textOf(byId("cwd"), String(init.cwd || ""));
  const defaults = init.defaults || {};

  wireEvents(defaults);
});
