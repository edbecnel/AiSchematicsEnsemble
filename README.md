# AiSchematicsEnsemble (v0.1)

Multi-LLM fanout + ensembling CLI for circuit/schematic recommendations.

If you just want to use the tool (inputs/outputs + examples), see **Help.md** (or open **help.html** for a browser-friendly version).

CLI install/setup guide (HTML, GitHub Pages-friendly): **cli-help.html**.

## What it does

- Queries multiple AI providers (OpenAI, xAI Grok, Gemini, Claude)
- Saves all raw model outputs for traceability
- Uses Claude as an **ensembler** to produce:
  - `final.md` (human explanation + test plan)
  - `final.cir` (SPICE netlist)
  - `final.json` (structured circuit spec)
- Generates a connectivity schematic from the SPICE netlist:
  - `schematic.dot` (Graphviz)
  - `schematic.png` (if Graphviz `dot` is installed)
- Generates a Word report: `report.docx`

### Higher-resolution schematic.png

- Best for zooming/printing: use `schematic.svg` (also generated when Graphviz is installed).
- For a higher-res PNG, rerun Graphviz with a higher DPI:

```powershell
dot -Gdpi=300 -Tpng runs\<run_id>\schematic.dot -o runs\<run_id>\schematic_300dpi.png
```

Or set it at run time:

```powershell
node dist/index.js run --question question.md --schematic-dpi 300
```

## Prereqs

- Node.js 18+ recommended
- Optional: Graphviz (`dot`) if you want `schematic.png` auto-rendered
- Optional: ngspice if you later add simulation (stub is included)

### Graphviz (Windows)

If you want `schematic.png` generated automatically, install Graphviz and ensure `dot` is on PATH:

1. Download the stable Windows x64 installer: https://graphviz.org/download/
2. Run the installer (enable “Add Graphviz to PATH” if offered)
3. Reopen PowerShell and verify:

```powershell
dot -V
where.exe dot
```

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

## API keys (.env)

## Windows / terminal notes

- This project is documented for Windows **PowerShell** and **Command Prompt (cmd.exe)**.
- Interactive prompts (baseline netlist/image prompts, and `chat`) require a real TTY. Run them in a normal terminal window; they may not behave correctly in non-interactive shells.

This tool talks to one or more model providers. Create a `.env` file:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Command Prompt (cmd):

```bat
copy .env.example .env
```

Then fill in the keys you plan to use:

- `OPENAI_API_KEY=`
- `ANTHROPIC_API_KEY=`
- `GEMINI_API_KEY=`
- `XAI_API_KEY=`

## Setup

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

## Quick start

Run the included example:

```powershell
npm run run:example
```

Or create your own `question.md` and run:

```powershell
node dist/index.js run --question question.md
```

## Usage overview

There are two primary modes:

1. **run** (batch mode): reads a question file and produces an output folder with `report.docx`, `final.*`, etc.
2. **chat** (interactive): a REPL where you can iteratively ask questions and update context.

There is also a local **ui** command that starts a browser-based form for batch runs.

## UI (local web page)

Start the local UI server (built JS):

```powershell
npm run build
npm run ui
```

Or run directly in TS (no build):

```powershell
npm run dev:ui
```

The page lets you save/load configs (localStorage + JSON import/export) and run batch mode.

Then open the printed URL (default is `http://127.0.0.1:3210/`; if the port is busy it will try `3211`, `3212`, etc.).

## Offline (no server)

Open offline.html directly in your browser. It does not run anything; it generates a config JSON and copy/paste commands for PowerShell and cmd.exe.

To run a saved config from the CLI:

```powershell
npm run build
node dist/index.js run --config ai-schematics.config.json
```

Notes:

- The tool does not generate `ai-schematics.config.json` automatically; it’s created when you download/export it from the UI/offline helper page (or when you write it yourself).
- You can store it anywhere. `--config` accepts a full path or a relative path from the project root.
- If you set “Config filename” to something like `config\ai-schematics.config.json`, move the downloaded JSON into `config/` so the generated command works.
- When you use the “…” file pickers in offline.html (no server), the browser cannot provide a real path. By default, offline.html embeds the picked file into the JSON config; alternatively you can enable “Prefer filename only (don’t embed)” to just fill the filename/path textbox (in that case, the CLI run must be able to read that file by that path).

## How to test: offline vs UI server

- Offline (no server): run the CLI directly.

```powershell
npm run build
node dist/index.js run --config ai-schematics.config.example.json --outdir runs_test_offline --no-prompts
```

- UI server: start the local server, then open the printed URL.

  Default is `http://127.0.0.1:3210/`; if the port is busy it will try `3211`, `3212`, etc.

```powershell
npm run build
npm run ui
```

## Chat (interactive)

Start an interactive chat session:

```powershell
npm run build
npm run chat
```

Or run directly in TS (no build):

```powershell
npm run dev:chat
```

Inside the chat REPL:

- `/help` shows commands
- `/provider openai|xai|google|anthropic|ensemble` switches backends
- `/model <name>` changes the model for the current provider
- `/netlist ...` sets/clears baseline netlist context during the session
- `/image ...` sets/clears a baseline schematic image during the session
- `/paste` lets you paste a multi-line message (end with `---END---`)

Tip: use `--save` to write `chat.md` + `chat.json` (and per-turn artifacts when using `ensemble`).

Useful flags:

```powershell
node dist/index.js chat --provider openai --openai-model gpt-5.2 --save
node dist/index.js chat --provider ensemble --save
node dist/index.js chat --baseline-netlist baseline.cir --baseline-image schematic.png --save
```

## Run (batch mode)

Batch mode reads a question prompt file and produces a timestamped run folder under `runs/`.

```powershell
node dist/index.js run --question question.md
```

Optional context you can provide:

- `--baseline-netlist path/to/baseline.cir`
- `--baseline-image path/to/schematic.png`
- `--bundle-includes` (optional): copies `.include` / `.lib` files referenced by `--baseline-netlist` into the run folder and rewrites `baseline.cir` there to point at them

Notes:

- These paths are resolved relative to the folder you run the command from (current working directory) unless you use absolute paths.
- `.include` directives in a baseline netlist are not resolved by this tool; the baseline netlist is included as text context for the models.

When `--bundle-includes` is used, the run folder will also contain:

- `baseline_original.cir` (the original baseline as read)
- `baseline.cir` (rewritten to reference copied include/lib files under `includes/`)
- `baseline_includes.json` (what was copied and what was missing)

If you omit these and are running in an interactive terminal, the CLI will prompt you to optionally add them.

## Inputs and outputs

Inputs:

- `question.md` (required for `run`): your prompt/question in Markdown or plain text
- baseline netlist `.cir` (optional): the current topology you want the tool to treat as “ground truth context”
- baseline image `.png/.jpg/.webp` (optional): screenshot/photo of a schematic

Outputs (in `runs/YYYYMMDD_HHMMSS/`):

- `report.docx` (Word report)
- `final.md` (final recommendation + test plan)
- `final.cir` (SPICE netlist)
- `final.json` (structured JSON with assumptions/probes/BOM/notes)
- `answers.json` + `answers/*.md` (raw model outputs)
- `schematic.dot` (+ `schematic.png` if Graphviz is installed)
- `baseline.cir` and `baseline_schematic.*` if provided

## Schematic screenshot input (alternative)

You can provide a schematic screenshot image instead of (or in addition to) a baseline netlist:

```powershell
node dist/index.js run --question question.md --baseline-image path/to/schematic.png
```

If you don't pass `--baseline-image`, and you're running in an interactive terminal, the CLI will prompt you to optionally add one.
The image is copied into the run folder as `baseline_schematic.<ext>` and (in v0.1) is attached to Claude and other vision-capable providers.

## Models

Defaults (override with flags):

- OpenAI: `gpt-5.2`
- xAI: `grok-4`
- Gemini: `gemini-2.5-flash`
- Claude: `claude-sonnet-4-5-20250929`

## Notes on "trusted schematic"

In v0.1 the schematic image is a _connectivity_ diagram generated directly from the netlist.
That guarantees wiring correctness even if it isn't pretty like a hand-drawn schematic.
In later revisions we can generate KiCad schematics for prettier exports.
