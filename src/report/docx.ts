import fs from "fs-extra";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun } from "docx";

function codeParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        font: "Consolas",
      }),
    ],
  });
}

export async function writeReportDocx(args: {
  outPath: string;
  title: string;
  question: string;
  finalMarkdown: string;
  spiceNetlist: string;
  baselineSchematicPath?: string;
  connectivitySchematicPngPath?: string;
}): Promise<void> {
  const baselineSection: Paragraph[] = [];
  if (args.baselineSchematicPath && (await fs.pathExists(args.baselineSchematicPath))) {
    baselineSection.push(new Paragraph({ text: "Baseline Schematic Screenshot", heading: HeadingLevel.HEADING_1 }));
    baselineSection.push(await imageParagraph(args.baselineSchematicPath, 720, 480));
  }

  const connectivitySection: Paragraph[] = [
    new Paragraph({ text: "Connectivity Schematic (Netlist-Derived)", heading: HeadingLevel.HEADING_1 }),
  ];
  if (args.connectivitySchematicPngPath && (await fs.pathExists(args.connectivitySchematicPngPath))) {
    connectivitySection.push(await imageParagraph(args.connectivitySchematicPngPath, 720, 480));
  } else {
    connectivitySection.push(
      new Paragraph("Connectivity schematic image not generated (Graphviz 'dot' not found or netlist parse failed)."),
    );
  }

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: args.title, heading: HeadingLevel.TITLE }),
          ...baselineSection,
          new Paragraph({ text: "Question", heading: HeadingLevel.HEADING_1 }),
          new Paragraph(args.question),
          new Paragraph({ text: "Ensembled Output (Markdown)", heading: HeadingLevel.HEADING_1 }),
          ...args.finalMarkdown.split(/\r?\n/).map((line) => new Paragraph(line)),
          new Paragraph({ text: "SPICE Netlist", heading: HeadingLevel.HEADING_1 }),
          ...args.spiceNetlist.split(/\r?\n/).map((line) => codeParagraph(line)),
          ...connectivitySection,
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  await fs.outputFile(args.outPath, buf);
}

async function imageParagraph(pngPath: string, width: number, height: number): Promise<Paragraph> {
  const data = Buffer.from(await fs.readFile(pngPath));
  const img = new ImageRun({
    type: "png",
    data,
    transformation: { width, height },
  });
  return new Paragraph({ children: [img] });
}
