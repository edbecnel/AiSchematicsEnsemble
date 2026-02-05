# AiSchematicsEnsemble — End-user Help

This document is for using the tool (inputs/outputs + interactive usage). For developer notes, see README.

For a more readable, browser-friendly version, open help.html.

CLI install/setup instructions (separate page): **cli-help.html**.

If you edit Help.md, refresh help.html with:

```powershell
npm run regen:help-html
```

## What you need

- Node.js 18+ recommended
- API keys for one or more providers in a `.env` file
- Optional: Graphviz (`dot`) if you want `schematic.png` auto-rendered

## Where to run commands

Run commands from the **project root folder** (the directory that contains `package.json`).

PowerShell:

```powershell
cd "D:\Dev\AiSchematicsEnsemble"
```

Command Prompt (cmd):

```bat
cd /d "D:\Dev\AiSchematicsEnsemble"
```

## Do I need Windows PowerShell?

No. You can run this from Windows **PowerShell** (including Windows Terminal) or **Command Prompt** (`cmd.exe`).

Interactive features (the baseline prompts and `chat`) require a real interactive terminal (TTY).

### 1) Install

PowerShell:

```powershell
npm install
npm run build
```

Command Prompt (cmd):

```bat
npm install
npm run build
```

### 2) Configure API keys

Copy the example env file:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Command Prompt (cmd):

```bat
copy .env.example .env
```

Edit `.env` and set whichever keys you plan to use:

- `OPENAI_API_KEY=`
- `ANTHROPIC_API_KEY=`
- `GEMINI_API_KEY=`
- `XAI_API_KEY=`

Notes:

- If a provider’s key is missing, calls to that provider will fail.
- The **ensemble** step uses Claude (Anthropic). If `ANTHROPIC_API_KEY` is not set, ensembling will fail.
- When running from the CLI, `.env` is loaded automatically from your current working directory (dotenv).

## Ways to use AiSchematicsEnsemble

1. **UI (local web page)** (`ui`) — a browser form to configure and run batch mode, with save/load of configs.
2. **Batch mode** (`run`) — you provide a `question.md` file, it generates a run folder with outputs.
3. **Interactive mode** (`chat`) — a REPL where you can ask follow-up questions and update context.

---

## UI mode: `ui`

PowerShell:

```powershell
npm run build
npm run ui
```

Dev/watch mode (auto rebuild + auto restart while you edit code):

```powershell
npm run ui:watch
```

Command Prompt (cmd):

```bat
npm run build
npm run ui
```

Notes:

- The UI is local-only and runs on your machine.
- If you edit TypeScript/HTML in `src/`, you must rebuild/restart the UI (or use `npm run ui:watch`).
- File paths you type into the UI are resolved by the server process, relative to the server’s current working directory.
- The UI can download `final.md`, `final.cir`, and `report.docx`, and can open the run folder in Explorer.

## Offline mode (no server)

Open offline.html directly in your browser. It does not run the tool; it helps you:

- Fill out inputs/models
- Download a config JSON
- Copy a ready-to-paste command line for PowerShell or cmd.exe

Then run the saved JSON config with:

```powershell
npm run build
node dist/index.js run --config ai-schematics.config.json
```

## How to test: offline (no server) vs UI (server)

### Test “offline / no server”

This uses the CLI directly. No web server is running.

1. Build:

```powershell
npm run build
```

2. Either:

- Use the offline helper page: open offline.html in a browser, fill the form, download a config JSON, then paste the generated command into PowerShell/cmd.

OR

- Use the example config:

```powershell
node dist/index.js run --config ai-schematics.config.example.json --outdir runs_test_offline --no-prompts
```

3. Verify outputs:

- A new folder is created under `runs_test_offline/` (or under `runs/` if you didn’t pass `--outdir`).
- Confirm you got `final.md`, `final.cir`, and `report.docx`.

### Test “UI / server mode”

This starts a local HTTP server and serves a web page.

1. Build and start UI:

```powershell
npm run build
npm run ui
```

2. Open the printed URL (default `http://127.0.0.1:3210/`; if the port is busy it will try `3211`, `3212`, etc.).

3. In the UI:

- Fill inputs and click Run, or import a config JSON.
- Use the “Copy/paste commands” section if you want to run the exact same config in a terminal instead.

4. Verify outputs:

- The UI should show the run folder and allow downloading `final.md`, `final.cir`, and `report.docx`.

### What’s the difference?

- Offline.html is just a helper page (no server). The actual run is always executed by the CLI (`node dist/index.js run ...`).
- UI mode adds convenience (form + saving + downloads) but still calls the same underlying runner.

Tip: if the CLI ever asks you to add a baseline netlist or schematic screenshot and you want a fully non-interactive run, add `--no-prompts`.

---

## Batch mode: `run`

### Required input

- `question.md` (or any `.md`/`.txt` file): your question/prompt.

A typical `question.md` looks like:

```markdown
# Goal

Explain what circuit you’re working on and what you want.

## Constraints

- Supply voltage/current limits
- Components you have on hand
- Measurement tools available

## Questions

- What should I change?
- What should I measure?
```

### Optional inputs (highly recommended)

You can provide either or both:

- `--baseline-netlist <path>`: a SPICE `.cir` file representing the current topology
- `--baseline-image <path>`: a schematic screenshot/photo (`.png/.jpg/.jpeg/.webp`)

If you omit either one **and you’re running interactively**, the CLI will prompt you to add them.

### Optional: bundle `.include` / `.lib` dependencies

If your baseline netlist references other files (e.g. `.include some.lib` or `.lib models.lib`), you can ask the tool to copy those dependency files into the run folder:

```powershell
node dist/index.js run --question question.md --baseline-netlist baseline.cir --bundle-includes
```

What it does:

- Copies referenced include/lib files into `runs/.../includes/`
- Writes `baseline_original.cir` (original)
- Writes `baseline.cir` rewritten to reference `includes/...`
- Writes `baseline_includes.json` listing copied and missing files

Limitations:

- This only works when the baseline is loaded from a **file path** (`--baseline-netlist ...` or choosing “file” in the prompt). If you paste a netlist, there is no source folder to resolve includes from.
- This does not simulate SPICE; it’s just bundling files for portability.

### Command

```powershell
node dist/index.js run --question path/to/question.md
```

With optional context:

```powershell
node dist/index.js run --question question.md --baseline-netlist baseline.cir --baseline-image schematic.png
```

### Path rules (baseline files)

- Paths you pass on the command line (like `--baseline-netlist baseline.cir` or `--baseline-image schematic.png`) are resolved **relative to the folder you run the command from** (your current working directory), unless you use an absolute path.
- For reliability, either:
  - run commands from the project root (recommended), and keep paths relative to that, or
  - use absolute paths.

### What about `.include` files referenced by the baseline `.cir`?

- This tool does **not** run SPICE on your baseline netlist. The baseline `.cir` is used as **context text** for the models, and is optionally saved into the run folder.
- `.include` directives in the baseline `.cir` are **not** followed/loaded by this tool.
- The connectivity diagram is generated from the **final** netlist the tool outputs (`final.cir`), and directives (including `.include`) are ignored by the simple connectivity parser.

If you later simulate with a SPICE tool (e.g., ngspice), include-file resolution depends on that simulator; use absolute paths or make include paths relative to the simulator’s working directory.

### Outputs

Each run creates a timestamped folder under `runs/` (or `--outdir`). Typical contents:

- `report.docx` — a Word report including the final writeup
- `final.md` — final recommendation + test plan
- `final.cir` — SPICE netlist
- `final.json` — structured JSON (assumptions/probes/bom/notes)
- `answers.json` — raw responses from each provider
- `answers/*.md` — raw responses as Markdown
- `schematic.dot` — connectivity diagram (Graphviz)
- `schematic.png` — rendered diagram (only if Graphviz `dot` is installed)
- `baseline.cir` — saved baseline netlist (if provided)
- `baseline_schematic.*` — saved image (if provided)

### Model selection

Defaults (override with flags):

- `--openai-model` (default `gpt-5.2`)
- `--grok-model` (default `grok-4`)
- `--gemini-model` (default `gemini-2.5-flash`)
- `--claude-model` (default `claude-sonnet-4-5-20250929`)

Example:

```powershell
node dist/index.js run --question question.md --openai-model gpt-5.2 --claude-model claude-sonnet-4-5-20250929
```

---

## Interactive mode: `chat`

### Start chat

```powershell
npm run chat
```

Or without building:

```powershell
npm run dev:chat
```

### Useful flags

Save a transcript and artifacts:

```powershell
node dist/index.js chat --save
```

Start with a baseline netlist/image already loaded:

```powershell
node dist/index.js chat --baseline-netlist baseline.cir --baseline-image schematic.png --save
```

Pick a provider:

```powershell
node dist/index.js chat --provider openai
node dist/index.js chat --provider ensemble
```

### Providers

`--provider` can be one of:

- `openai`
- `xai`
- `google`
- `anthropic`
- `ensemble` (fanout to multiple models, then Claude ensembles the result)

### Chat commands

In the REPL, type `/help` to see the latest commands. Common ones:

- `/provider <name>` — switch provider (`openai|xai|google|anthropic|ensemble`)
- `/model <name>` — change model for the current provider
- `/paste` — enter a multi-line message (end with a line `---END---`)
- `/status` — show current provider/model + whether baseline netlist/image is set
- `/reset` — clear conversation history
- `/exit` or `/quit` — exit the REPL

#### Update context during chat

Baseline netlist commands:

- `/netlist file <path>` — load netlist from file
- `/netlist paste` — paste a multi-line netlist (end `---END---`)
- `/netlist show` — print the current baseline netlist
- `/netlist clear` — clear the baseline netlist

Baseline image commands:

- `/image <path>` — set/update baseline schematic image
- `/image clear` — clear it

### Saving transcripts

If you start chat with `--save` (or run `/save` inside chat), a run folder is created under `runs/` containing:

- `chat.md` — readable transcript
- `chat.json` — structured transcript

If you use provider `ensemble`, each turn also writes per-turn artifacts under `turns/` (fanout and ensemble outputs).

---

## Troubleshooting

### “Graphviz 'dot' not found”

That’s expected if Graphviz isn’t installed. You will still get `schematic.dot`. Install Graphviz and ensure `dot` is on your PATH to also get `schematic.png`.

#### Install Graphviz on Windows

1. Download the official Graphviz Windows x64 installer:

- https://graphviz.org/download/ (pick the stable Windows build)

2. Run the installer.

- If it offers an option like “Add Graphviz to PATH”, enable it.

3. Close and reopen your terminal, then verify `dot` is available:

```powershell
dot -V
where.exe dot
```

### Provider errors / empty responses

- Check you set the correct API key in `.env`
- Ensure your network allows outbound calls
- Try switching provider or model

### I want to automate runs

Use batch mode and commit your `question.md` (and optional `baseline.cir`) alongside your project so runs are reproducible.
