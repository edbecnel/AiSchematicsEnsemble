import type { SpiceComponent } from "./parse.js";

export function netlistToDot(comps: SpiceComponent[]): string {
  // bipartite graph: components (boxes) and nets (ellipses)
  const nets = new Set<string>();
  for (const c of comps) for (const n of c.nodes) nets.add(n);

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

  let dot = "digraph G {\n";
  dot += "  rankdir=LR;\n";
  dot += "  graph [splines=true, overlap=false];\n";
  dot += "  node  [fontsize=10];\n\n";

  // Nets
  dot += "  // Nets\n";
  for (const n of Array.from(nets)) {
    dot += `  net_${sanitize(n)} [label="${n}", shape=ellipse];\n`;
  }
  dot += "\n  // Components\n";
  for (const c of comps) {
    dot += `  comp_${sanitize(c.ref)} [label="${c.ref}", shape=box];\n`;
  }

  dot += "\n  // Edges (net -> component)\n";
  for (const c of comps) {
    for (const n of c.nodes) {
      dot += `  net_${sanitize(n)} -> comp_${sanitize(c.ref)};\n`;
    }
  }

  dot += "}\n";
  return dot;
}
