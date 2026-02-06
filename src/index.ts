#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import { execa } from "execa";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { makeRunDir } from "./util/runDir.js";
import { readTextIfExists, writeText, writeJson } from "./util/io.js";
import { loadImageAsBase64 } from "./util/image.js";
import { bundleSpiceIncludes } from "./util/spiceIncludes.js";
import { askOpenAI } from "./providers/openai.js";
import { askGrok } from "./providers/xai.js";
import { askGemini } from "./providers/gemini.js";
import { askClaude } from "./providers/anthropic.js";
import { buildEnsemblePrompt, parseEnsembleOutputs } from "./ensemble.js";
import { parseNetlist } from "./netlist/parse.js";
import { netlistToDot } from "./netlist/graph.js";
import { writeReportDocx } from "./report/docx.js";
import type { InputImage, ModelAnswer, ProviderName } from "./types.js";
import { runBatch } from "./runBatch.js";
import { startUiServer } from "./ui/server.js";
import { mergeRunConfig, readRunConfig } from "./util/runConfig.js";

type ChatProvider = ProviderName | "ensemble";

type ChatTurn = {
  user: string;
  assistant: string;
  provider: ChatProvider;
  model: string;
  ts: string;
};

function formatChatPrompt(args: {
  systemPreamble: string;
  baselineNetlist?: string;
  hasBaselineImage: boolean;
  turns: ChatTurn[];
  userMessage: string;
}): string {
  const baseline = args.baselineNetlist?.trim()
    ? `\nBASELINE NETLIST (context / ground truth if provided):\n\n\`\`\`spice\n${args.baselineNetlist.trim()}\n\`\`\`\n`
    : "";

  const imageNote = args.hasBaselineImage
    ? "\nBASELINE SCHEMATIC IMAGE: An image is attached as additional context.\n"
    : "";

  const transcript = args.turns
    .map((t) => `User: ${t.user}\nAssistant: ${t.assistant}`)
    .join("\n\n");

  const transcriptBlock = transcript ? `\nCONVERSATION SO FAR:\n${transcript}\n` : "";

  return `${args.systemPreamble.trim()}\n${baseline}${imageNote}${transcriptBlock}\nUser: ${args.userMessage.trim()}\nAssistant:`;
}

async function askSingleProvider(args: {
  provider: ProviderName;
  prompt: string;
  model: string;
  image?: InputImage;
}): Promise<ModelAnswer> {
  switch (args.provider) {
    case "openai":
      return askOpenAI(args.prompt, args.model, args.image);
    case "xai":
      return askGrok(args.prompt, args.model, args.image);
    case "google":
      return askGemini(args.prompt, args.model, args.image);
    case "anthropic":
      return askClaude(args.prompt, args.model, 1200, args.image);
  }
}

type BaselineNetlist = { text?: string; sourcePath?: string };

async function loadBaselineNetlist(existingPath?: string): Promise<BaselineNetlist> {
  if (existingPath && existingPath.trim()) {
    const fromFile = await readTextIfExists(existingPath);
    if (fromFile && fromFile.trim()) return { text: fromFile, sourcePath: existingPath };
  }
  if (!process.stdin.isTTY) return {};

  const rl = createInterface({ input, output });
  try {
    const yn = (await rl.question("No baseline netlist provided. Add one now? [y/N]: ")).trim().toLowerCase();
    if (!(yn === "y" || yn === "yes")) return {};

    const mode = (await rl.question("Provide baseline as (f)ile path or (p)aste? [f/p]: ")).trim().toLowerCase();

    if (mode.startsWith("f")) {
      const fp = (await rl.question("Path to netlist file (.cir): ")).trim();
      if (!fp) return {};
      const ok = await fs.pathExists(fp);
      if (!ok) {
        console.log(chalk.yellow(`File not found: ${fp}`));
        return {};
      }
      const text = await fs.readFile(fp, "utf-8");
      return { text, sourcePath: fp };
    }

    console.log(chalk.cyan("Paste SPICE netlist now. End with a line containing only ---END---"));
    const lines: string[] = [];
    while (true) {
      const line = await rl.question("");
      if (line.trim() === "---END---") break;
      lines.push(line);
    }
    const pasted = lines.join("\n").trim();
    return pasted ? { text: pasted } : {};
  } finally {
    rl.close();
  }
}

async function maybePromptForBaselineImage(existingPath?: string): Promise<string | undefined> {
  if (existingPath && existingPath.trim()) return existingPath;
  if (!process.stdin.isTTY) return undefined;

  const rl = createInterface({ input, output });
  try {
    const yn = (await rl.question("Add a schematic screenshot image? [y/N]: ")).trim().toLowerCase();
    if (!(yn === "y" || yn === "yes")) return undefined;

    const fp = (await rl.question("Path to image file (.png/.jpg/.jpeg/.webp): ")).trim();
    if (!fp) return undefined;
    const ok = await fs.pathExists(fp);
    if (!ok) {
      console.log(chalk.yellow(`File not found: ${fp}`));
      return undefined;
    }
    return fp;
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name("ai-schematics-ensemble")
  .description("Multi-LLM fanout + Claude ensembling for bedini, babcock, half wave bridge circuits.")
  .version("0.1.0");

program
  .command("run")
  .description("Run fanout + ensemble, producing report.docx, final.cir, schematic.dot/png.")
  .option("--config <path>", "JSON config file containing run options")
  .option("--question <path>", "Markdown/text file with the question/prompt")
  .option("--baseline-netlist <path>", "Optional SPICE netlist representing current baseline circuit")
  .option("--baseline-image <path>", "Optional schematic screenshot image (png/jpg/webp)")
  .option("--no-prompts", "Disable interactive prompts for missing baseline netlist/image")
  .option(
    "--bundle-includes",
    "Copy .include/.lib files referenced by baseline netlist into the run folder and rewrite baseline.cir to point at them",
    false,
  )
  .option("--outdir <path>", "Output directory root", "runs")
  .option("--openai-model <name>", "OpenAI model", "gpt-5.2")
  .option("--grok-model <name>", "xAI Grok model", "grok-4")
  .option("--gemini-model <name>", "Gemini model", "gemini-2.5-flash")
  .option("--claude-model <name>", "Claude model", "claude-sonnet-4-5-20250929")
  .action(async (opts) => {
    try {
      const cfg = opts.config ? await readRunConfig(String(opts.config)) : undefined;
      const merged = cfg ? mergeRunConfig(opts, cfg) : undefined;
      const questionPath = merged?.questionPath ?? String(opts.question ?? "").trim();

      if (!questionPath) {
        console.error(chalk.red("Missing required input. Provide either --question <path> or --config <path>."));
        process.exitCode = 2;
        return;
      }

      const result = await runBatch({
        questionPath,
        baselineNetlistPath: merged?.baselineNetlistPath ?? opts.baselineNetlist,
        baselineImagePath: merged?.baselineImagePath ?? opts.baselineImage,
        bundleIncludes: merged?.bundleIncludes ?? Boolean(opts.bundleIncludes),
        outdir: merged?.outdir ?? opts.outdir,
        openaiModel: merged?.openaiModel ?? opts.openaiModel,
        grokModel: merged?.grokModel ?? opts.grokModel,
        geminiModel: merged?.geminiModel ?? opts.geminiModel,
        claudeModel: merged?.claudeModel ?? opts.claudeModel,
        allowPrompts: Boolean(opts.prompts),
      });

      console.log(chalk.green("Done."));
      console.log(chalk.cyan(`Outputs:`));
      console.log(`- ${result.outputs.reportDocx}`);
      console.log(`- ${result.outputs.finalCir}`);
      console.log(`- ${result.outputs.finalMd}`);
      console.log(`- ${result.outputs.schematicDot}${result.outputs.schematicPng ? " + schematic.png" : ""}`);
      if (result.outputs.baselineImage) console.log(`- ${result.outputs.baselineImage}`);
    } catch (e: any) {
      console.error(chalk.red(String(e?.message ?? e)));
      process.exitCode = 2;
    }
  });

program
  .command("ui")
  .description("Start a local web UI for configuring and running batch mode.")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <n>", "Port to listen on", "3210")
  .option("--outdir <path>", "Default output directory root", "runs")
  .option("--no-open", "Do not auto-open a browser")
  .action(async (opts) => {
    const port = Number.parseInt(String(opts.port ?? "3210"), 10) || 3210;
    const host = String(opts.host ?? "127.0.0.1");
    const outdir = String(opts.outdir ?? "runs");
    const openBrowser = Boolean(opts.open);

    const started = await startUiServer({ host, port, outdir, openBrowser });
    console.log(chalk.cyan(`UI running at: ${started.url}`));
    console.log(chalk.dim("Press Ctrl+C to stop."));
  });

program
  .command("chat")
  .description("Interactive chat REPL (supports OpenAI/xAI/Gemini/Claude or full ensemble per turn).")
  .option("--provider <name>", "Provider: openai|xai|google|anthropic|ensemble", "openai")
  .option("--openai-model <name>", "OpenAI model", "gpt-5.2")
  .option("--grok-model <name>", "xAI Grok model", "grok-4")
  .option("--gemini-model <name>", "Gemini model", "gemini-2.5-flash")
  .option("--claude-model <name>", "Claude model", "claude-sonnet-4-5-20250929")
  .option("--baseline-netlist <path>", "Optional SPICE netlist baseline context")
  .option("--baseline-image <path>", "Optional schematic screenshot image (png/jpg/webp)")
  .option("--max-history <n>", "Max prior turns to include in each prompt", "10")
  .option("--save", "Save transcript + any artifacts into a run folder", false)
  .option("--outdir <path>", "Output directory root for --save", "runs")
  .action(async (opts) => {
    const parsedProvider = String(opts.provider || "openai").trim().toLowerCase() as ChatProvider;
    const provider: ChatProvider =
      parsedProvider === "openai" ||
      parsedProvider === "xai" ||
      parsedProvider === "google" ||
      parsedProvider === "anthropic" ||
      parsedProvider === "ensemble"
        ? parsedProvider
        : "openai";

    const maxHistory = Math.max(0, Math.min(50, Number.parseInt(String(opts.maxHistory ?? "10"), 10) || 10));

    let runDir: string | undefined;
    let savedBaselineImagePath: string | undefined;
    let baselineImageFilename: string | undefined;

    const ensureRunDir = async (): Promise<string> => {
      if (runDir) return runDir;
      runDir = await makeRunDir(opts.outdir);
      await fs.mkdirp(path.join(runDir, "turns"));
      console.log(chalk.cyan(`Run directory: ${runDir}`));
      return runDir;
    };

    const baselineLoaded = await loadBaselineNetlist(opts.baselineNetlist);
    let baselineNetlist = baselineLoaded.text;

    let baselineImagePath: string | undefined = opts.baselineImage;
    baselineImagePath = await maybePromptForBaselineImage(baselineImagePath);

    let baselineNetlistSourcePath: string | undefined = baselineLoaded.sourcePath;

    let baselineImage: InputImage | undefined;
    if (baselineImagePath) {
      baselineImage = await loadImageAsBase64(baselineImagePath);
      baselineImageFilename = baselineImage.filename || "baseline_schematic";

      if (opts.save) {
        const dir = await ensureRunDir();
        const ext = path.extname(baselineImagePath);
        savedBaselineImagePath = path.join(dir, `baseline_schematic${ext}`);
        await fs.copy(baselineImagePath, savedBaselineImagePath);
      }
    }

    if (baselineNetlist && opts.save) {
      const dir = await ensureRunDir();
      await writeText(path.join(dir, "baseline.cir"), baselineNetlist);
    }

    let currentProvider: ChatProvider = provider;
    const models = {
      openai: String(opts.openaiModel ?? "gpt-5.2"),
      xai: String(opts.grokModel ?? "grok-4"),
      google: String(opts.geminiModel ?? "gemini-2.5-flash"),
      anthropic: String(opts.claudeModel ?? "claude-sonnet-4-5-20250929"),
      ensemble: String(opts.claudeModel ?? "claude-sonnet-4-5-20250929"),
    } as const;

    const systemPreamble =
      "You are an interactive technical assistant. Be precise, ask clarifying questions when needed, and keep answers actionable.";

    const turns: ChatTurn[] = [];

    const rl = createInterface({ input, output });

    const persistBaselineNetlist = async () => {
      if (!opts.save) return;
      const dir = await ensureRunDir();
      if (baselineNetlist?.trim()) {
        await writeText(path.join(dir, "baseline.cir"), baselineNetlist);
      }
    };

    const setBaselineNetlist = async (next?: string) => {
      baselineNetlist = next?.trim() ? next : undefined;
      await persistBaselineNetlist();
      console.log(chalk.cyan(`Baseline netlist: ${baselineNetlist?.trim() ? "set" : "cleared"}`));
    };

    const persistBaselineImage = async (sourcePath: string) => {
      if (!opts.save) return;
      const dir = await ensureRunDir();
      const ext = path.extname(sourcePath);
      savedBaselineImagePath = path.join(dir, `baseline_schematic${ext}`);
      await fs.copy(sourcePath, savedBaselineImagePath);
    };

    const setBaselineImage = async (sourcePath?: string) => {
      if (!sourcePath?.trim()) {
        baselineImage = undefined;
        baselineImageFilename = undefined;
        savedBaselineImagePath = undefined;
        console.log(chalk.cyan("Baseline image: cleared"));
        return;
      }

      const ok = await fs.pathExists(sourcePath);
      if (!ok) {
        console.log(chalk.yellow(`File not found: ${sourcePath}`));
        return;
      }

      baselineImage = await loadImageAsBase64(sourcePath);
      baselineImageFilename = baselineImage.filename || path.basename(sourcePath);
      if (opts.save) await persistBaselineImage(sourcePath);
      console.log(chalk.cyan(`Baseline image: set (${baselineImageFilename})`));
    };
    const printHelp = () => {
      console.log(chalk.cyan("Commands:"));
      console.log("  /help                Show this help");
      console.log("  /exit | /quit         Exit chat");
      console.log("  /provider <name>      Set provider: openai|xai|google|anthropic|ensemble");
      console.log("  /model <name>         Set model for current provider");
      console.log("  /netlist              Manage baseline netlist (context)");
      console.log("    /netlist file <path>    Load from file");
      console.log("    /netlist paste          Paste multi-line netlist (end with ---END---)");
      console.log("    /netlist clear          Clear baseline netlist");
      console.log("  /image <path>         Set baseline schematic image (or /image clear)");
      console.log("  /reset                Clear conversation history");
      console.log("  /paste                Multi-line message (end with ---END---)");
      console.log("  /save                 Save transcript now (creates run folder if needed)");
      console.log("  /status               Show current provider/model + context flags");
    };

    const saveTranscript = async () => {
      const dir = await ensureRunDir();
      await writeJson(path.join(dir, "chat.json"), {
        provider: currentProvider,
        models,
        baselineNetlistPresent: Boolean(baselineNetlist?.trim()),
        baselineImagePresent: Boolean(baselineImage),
        baselineImageFilename: baselineImageFilename ? path.basename(savedBaselineImagePath ?? baselineImageFilename) : undefined,
        turns,
      });
      const text = turns
        .map((t) => {
          const header = `# ${t.ts} | ${t.provider} | ${t.model}`;
          return `${header}\n\nUser:\n${t.user}\n\nAssistant:\n${t.assistant}\n`;
        })
        .join("\n---\n\n");
      await writeText(path.join(dir, "chat.md"), text);
      console.log(chalk.green(`Saved: ${path.join(dir, "chat.md")}`));
    };

    console.log(chalk.cyan("Interactive chat started."));
    console.log(chalk.dim("Type /help for commands. Use /exit to quit."));

    try {
      while (true) {
        const raw = await rl.question(chalk.green("you> "));
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith("/")) {
          const [cmd, ...rest] = line.slice(1).split(/\s+/);
          const arg = rest.join(" ").trim();

          if (cmd === "help") {
            printHelp();
            continue;
          }
          if (cmd === "exit" || cmd === "quit") {
            break;
          }
          if (cmd === "reset") {
            turns.length = 0;
            console.log(chalk.yellow("History cleared."));
            continue;
          }
          if (cmd === "provider") {
            const p = arg.toLowerCase();
            if (p === "openai" || p === "xai" || p === "google" || p === "anthropic" || p === "ensemble") {
              currentProvider = p as ChatProvider;
              console.log(chalk.cyan(`Provider: ${currentProvider}`));
            } else {
              console.log(chalk.yellow("Unknown provider. Use: openai|xai|google|anthropic|ensemble"));
            }
            continue;
          }
          if (cmd === "model") {
            if (!arg) {
              console.log(chalk.yellow("Usage: /model <name>"));
              continue;
            }
            (models as any)[currentProvider] = arg;
            console.log(chalk.cyan(`Model for ${currentProvider}: ${(models as any)[currentProvider]}`));
            continue;
          }
          if (cmd === "status") {
            console.log(chalk.cyan(`Provider: ${currentProvider}`));
            console.log(chalk.cyan(`Model: ${(models as any)[currentProvider]}`));
            console.log(
              chalk.cyan(
                `Baseline netlist: ${baselineNetlist?.trim() ? `yes (${baselineNetlist.length} chars)` : "no"}`,
              ),
            );
            console.log(chalk.cyan(`Baseline image: ${baselineImage ? `yes (${baselineImageFilename ?? "image"})` : "no"}`));
            continue;
          }
          if (cmd === "netlist") {
            const sub = arg.trim();
            const [subcmd, ...rest2] = sub.split(/\s+/);
            const restArg = rest2.join(" ").trim();

            if (!subcmd || subcmd === "help") {
              console.log(chalk.cyan("Netlist commands:"));
              console.log("  /netlist file <path>");
              console.log("  /netlist paste");
              console.log("  /netlist clear");
              console.log("  /netlist show");
              continue;
            }

            if (subcmd === "clear") {
              await setBaselineNetlist(undefined);
              continue;
            }

            if (subcmd === "show") {
              if (!baselineNetlist?.trim()) {
                console.log(chalk.yellow("No baseline netlist set."));
              } else {
                console.log(chalk.white(baselineNetlist.trim()));
              }
              continue;
            }

            if (subcmd === "file") {
              let fp = restArg;
              if (!fp) fp = (await rl.question("Path to netlist file (.cir): ")).trim();
              if (!fp) continue;
              const ok = await fs.pathExists(fp);
              if (!ok) {
                console.log(chalk.yellow(`File not found: ${fp}`));
                continue;
              }
              const text = await fs.readFile(fp, "utf-8");
              baselineNetlistSourcePath = fp;
              await setBaselineNetlist(text);
              continue;
            }

            if (subcmd === "paste") {
              console.log(chalk.cyan("Paste SPICE netlist now. End with a line containing only ---END---"));
              const lines: string[] = [];
              while (true) {
                const l = await rl.question("");
                if (l.trim() === "---END---") break;
                lines.push(l);
              }
              const pasted = lines.join("\n").trim();
              await setBaselineNetlist(pasted || undefined);
              continue;
            }

            console.log(chalk.yellow("Unknown /netlist subcommand. Use /netlist help"));
            continue;
          }

          if (cmd === "image") {
            const sub = arg.trim();
            if (!sub || sub === "help") {
              console.log(chalk.cyan("Image commands:"));
              console.log("  /image <path>");
              console.log("  /image clear");
              continue;
            }
            if (sub.toLowerCase() === "clear") {
              await setBaselineImage(undefined);
              continue;
            }
            await setBaselineImage(sub);
            continue;
          }
          if (cmd === "save") {
            await saveTranscript();
            continue;
          }
          if (cmd === "paste") {
            console.log(chalk.cyan("Paste message. End with a line containing only ---END---"));
            const lines: string[] = [];
            while (true) {
              const l = await rl.question("");
              if (l.trim() === "---END---") break;
              lines.push(l);
            }
            const pasted = lines.join("\n").trim();
            if (!pasted) continue;
            // fall through into normal handling
            await handleUserMessage(pasted);
            continue;
          }

          console.log(chalk.yellow("Unknown command. Type /help."));
          continue;
        }

        await handleUserMessage(line);
      }
    } finally {
      rl.close();
    }

    if (opts.save && turns.length) {
      await saveTranscript();
    }

    async function handleUserMessage(userMessage: string) {
      const prompt = formatChatPrompt({
        systemPreamble,
        baselineNetlist,
        hasBaselineImage: Boolean(baselineImage),
        turns: maxHistory ? turns.slice(-maxHistory) : [],
        userMessage,
      });

      const ts = new Date().toISOString();
      const model = (models as any)[currentProvider] as string;

      if (currentProvider === "ensemble") {
        console.log(chalk.cyan("Ensembling (fanout + Claude)..."));

        const fanoutAnswers = await Promise.all<ModelAnswer>([
          askOpenAI(prompt, models.openai, baselineImage),
          askGrok(prompt, models.xai, baselineImage),
          askGemini(prompt, models.google, baselineImage),
          askClaude(prompt, models.anthropic, 1200, baselineImage),
        ]);

        const ensemblePrompt = buildEnsemblePrompt({
          question: prompt,
          baselineNetlist,
          baselineImageFilename: baselineImageFilename
            ? path.basename(savedBaselineImagePath ?? baselineImageFilename)
            : undefined,
          answers: fanoutAnswers,
        });

        const ensemble = await askClaude(ensemblePrompt, models.ensemble, 2400, baselineImage);

        if (opts.save) {
          const dir = await ensureRunDir();
          const turnN = String(turns.length + 1).padStart(3, "0");
          const turnDir = path.join(dir, "turns", `turn_${turnN}`);
          await fs.mkdirp(turnDir);
          await writeJson(path.join(turnDir, "fanout.json"), fanoutAnswers);
          await writeText(path.join(turnDir, "ensemble_raw.txt"), ensemble.text || ensemble.error || "");
        }

        if (ensemble.error || !ensemble.text) {
          const errText = ensemble.error ?? "No text returned";
          console.log(chalk.red(errText));
          turns.push({ user: userMessage, assistant: errText, provider: currentProvider, model, ts });
          return;
        }

        const out = parseEnsembleOutputs(ensemble.text);
        const missingSpice = !out.spiceNetlist.trim();
        const missingJson = !out.circuitJson.trim();

        const assistantText =
          out.finalMarkdown?.trim() ||
          (missingSpice
            ? "(WARNING) Ensemble did not include a SPICE netlist block; see ensemble_raw.txt.\n\n" + ensemble.text.trim()
            : ensemble.text.trim());
        console.log(chalk.white(assistantText));

        if (opts.save) {
          const dir = await ensureRunDir();
          const turnN = String(turns.length + 1).padStart(3, "0");
          const turnDir = path.join(dir, "turns", `turn_${turnN}`);
          await fs.mkdirp(turnDir);
          await writeText(path.join(turnDir, "final.md"), out.finalMarkdown);

          const finalCirText = missingSpice
            ? [
                "* ERROR: Ensemble output missing <spice_netlist> block.",
                "* See ensemble_raw.txt for the full model output.",
                ".end",
                "",
              ].join("\n")
            : out.spiceNetlist;

          const finalJsonText = missingJson
            ? JSON.stringify(
                {
                  error: "Ensemble output missing <circuit_json> block.",
                  assumptions: [],
                  probes: [],
                  bom: [],
                  notes: ["See ensemble_raw.txt for full model output."],
                },
                null,
                2,
              ) + "\n"
            : out.circuitJson;

          await writeText(path.join(turnDir, "final.cir"), finalCirText);
          await writeText(path.join(turnDir, "final.json"), finalJsonText);
        }

        turns.push({ user: userMessage, assistant: assistantText, provider: currentProvider, model, ts });
        return;
      }

      const single = await askSingleProvider({
        provider: currentProvider,
        prompt,
        model,
        image: baselineImage,
      });

      const assistantText = single.error ? `ERROR: ${single.error}` : (single.text || "").trim();
      console.log(single.error ? chalk.red(assistantText) : chalk.white(assistantText));

      turns.push({ user: userMessage, assistant: assistantText, provider: currentProvider, model, ts });
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(String(err?.stack ?? err)));
  process.exit(1);
});
