/**
 * Very small SPICE netlist parser for connectivity diagrams.
 * Supports common component lines:
 *   R*, C*, L*, D*, Q*, M*, V*, I*, X* (subckt call)
 *
 * This is NOT a full SPICE parser; it's intentionally conservative.
 */

export interface SpiceComponent {
  ref: string;
  nodes: string[];
  raw: string;
}

const COMMENT_RE = /^\s*[\*;]/;

export function parseNetlist(netlist: string): SpiceComponent[] {
  const lines = netlist.split(/\r?\n/);
  const comps: SpiceComponent[] = [];

  for (const line0 of lines) {
    const line = line0.trim();
    if (!line) continue;
    if (COMMENT_RE.test(line)) continue;
    if (line.startsWith(".")) continue; // directive

    // Remove inline comments starting with ';'
    const body = line.split(";")[0].trim();
    if (!body) continue;

    const parts = body.split(/\s+/);
    const ref = parts[0];
    if (!ref) continue;

    // Basic heuristic: first token ref, next 2+ tokens are nodes until we hit a value/model token.
    // For our diagram we mainly need the first 2-4 nodes.
    const nodes: string[] = [];
    for (let k = 1; k < parts.length; k++) {
      const tok = parts[k];
      // stop if token looks like a value (contains digit) and we already got at least 2 nodes
      if (nodes.length >= 2 && /\d/.test(tok)) break;
      // stop if token looks like a model assignment and we already got at least 2 nodes
      if (nodes.length >= 2 && tok.includes("=")) break;
      // stop if token begins with "DC" for sources after nodes collected
      if (nodes.length >= 2 && tok.toUpperCase() === "DC") break;

      nodes.push(tok);
      // guard: don't take absurdly long node lists
      if (nodes.length >= 6) break;
    }

    if (nodes.length >= 2) {
      comps.push({ ref, nodes, raw: body });
    }
  }

  return comps;
}
