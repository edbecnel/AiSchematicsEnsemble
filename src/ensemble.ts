import type { ModelAnswer, EnsembleOutputs } from "./types.js";

const TAG_MD_OPEN = "<final_markdown>";
const TAG_MD_CLOSE = "</final_markdown>";
const TAG_SPICE_OPEN = "<spice_netlist>";
const TAG_SPICE_CLOSE = "</spice_netlist>";
const TAG_JSON_OPEN = "<circuit_json>";
const TAG_JSON_CLOSE = "</circuit_json>";

export function buildEnsemblePrompt(args: {
  question: string;
  baselineNetlist?: string;
  baselineImageFilename?: string;
  answers: ModelAnswer[];
}): string {
  const blocks = args.answers
    .map((a) => {
      const header = `## Provider: ${a.provider} | Model: ${a.model}`;
      const body = a.error ? `(ERROR) ${a.error}` : (a.text || "").trim();
      return `${header}\n\n${body}\n`;
    })
    .join("\n---\n");

  const baseline = args.baselineNetlist
    ? `\nBASELINE NETLIST (treat as current ground truth topology):\n\n\
\
\`\`\`spice\n${args.baselineNetlist.trim()}\n\`\`\`\n`
    : "";

  const baselineImageNote = args.baselineImageFilename
    ? `\nSCHEMATIC SCREENSHOT PROVIDED: ${args.baselineImageFilename}\n- Use the attached image as reference for topology/components.\n- If it conflicts with any model text, prefer the screenshot + baseline netlist.\n`
    : "";

  return `You are an expert electrical engineer + experimentalist.
Your job is to ensemble multiple AI outputs into a single careful recommendation.
  We are working on bedini, babcock, half wave bridge circuits; focus on testable advice.

QUESTION:
${args.question.trim()}
${baseline}${baselineImageNote}

MODEL OUTPUTS:
${blocks}

HARD REQUIREMENTS:
- If you propose a circuit, output a SPICE netlist that is runnable at a block level.
- Explicitly list disagreements and how to resolve them with measurements.
- Provide a minimal bench experiment plan.
- Flag safety risks (inductive spikes, battery hazards).
- If something is uncertain, state the missing info.

OUTPUT FORMAT (MUST match exactly):
${TAG_MD_OPEN}
(Markdown report. Use headings/bullets.)
${TAG_MD_CLOSE}

${TAG_SPICE_OPEN}
(Plain SPICE netlist. Include .tran. Include .model definitions if needed.)
${TAG_SPICE_CLOSE}

${TAG_JSON_OPEN}
(Strict JSON. Must be valid. Include keys: assumptions[], probes[], bom[], notes[].)
${TAG_JSON_CLOSE}
`;
}

function extractBetween(text: string, open: string, close: string): string | undefined {
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  if (i === -1 || j === -1 || j <= i) return undefined;
  return text.substring(i + open.length, j).trim();
}

export function parseEnsembleOutputs(text: string): EnsembleOutputs {
  const finalMarkdown = extractBetween(text, TAG_MD_OPEN, TAG_MD_CLOSE) ?? "";
  const spiceNetlist = extractBetween(text, TAG_SPICE_OPEN, TAG_SPICE_CLOSE) ?? "";
  const circuitJson = extractBetween(text, TAG_JSON_OPEN, TAG_JSON_CLOSE) ?? "";

  return { finalMarkdown, spiceNetlist, circuitJson };
}
