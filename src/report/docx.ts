import fs from "fs-extra";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun } from "docx";

type DocxImageType = "png" | "jpg" | "gif" | "bmp";

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function imageTypeFromPath(p: string): DocxImageType | undefined {
  const ext = (p.split("?")[0]?.split("#")[0] ?? "").toLowerCase();
  if (ext.endsWith(".png")) return "png";
  if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "jpg";
  if (ext.endsWith(".gif")) return "gif";
  if (ext.endsWith(".bmp")) return "bmp";
  return undefined;
}

function readPngSize(buf: Buffer): { width: number; height: number } | undefined {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length < 24) return undefined;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  )
    return undefined;
  // IHDR chunk starts at offset 8: length(4) + type(4) + data(13)
  // Width/Height are the first 8 bytes of IHDR data at offsets 16/20.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function readJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  // JPEG starts with FF D8
  if (buf.length < 4) return undefined;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;

  const isSof = (marker: number) =>
    [
      0xc0, 0xc1, 0xc2, 0xc3,
      0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb,
      0xcd, 0xce, 0xcf,
    ].includes(marker);

  let offset = 2;
  while (offset + 4 < buf.length) {
    // Find 0xFF marker prefix (may have padding 0xFF bytes)
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) break;
    const marker = buf[offset];
    offset++;

    // Standalone markers without length
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
    if (offset + 2 > buf.length) break;
    const segmentLen = buf.readUInt16BE(offset);
    if (segmentLen < 2) return undefined;
    const segmentStart = offset + 2;

    if (isSof(marker)) {
      // SOF segment layout: [precision(1)] [height(2)] [width(2)] ...
      if (segmentStart + 5 > buf.length) return undefined;
      const height = buf.readUInt16BE(segmentStart + 1);
      const width = buf.readUInt16BE(segmentStart + 3);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
      return { width, height };
    }

    offset = segmentStart + (segmentLen - 2);
  }
  return undefined;
}

function scaleToFit(intrinsic: { width: number; height: number }, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const w = intrinsic.width;
  const h = intrinsic.height;
  const scale = Math.min(maxWidth / w, maxHeight / h, 1);
  return {
    width: clampInt(w * scale, 1, maxWidth),
    height: clampInt(h * scale, 1, maxHeight),
  };
}

function scaleToFitWidth(intrinsic: { width: number; height: number }, maxWidth: number): { width: number; height: number } {
  const w = intrinsic.width;
  const h = intrinsic.height;
  const scale = maxWidth / w;
  return {
    width: clampInt(w * scale, 1, maxWidth),
    height: Math.max(1, Math.round(h * scale)),
  };
}

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
  answers?: Array<{ heading: string; markdown: string }>;
}): Promise<void> {
  const baselineSection: Paragraph[] = [];
  if (args.baselineSchematicPath && (await fs.pathExists(args.baselineSchematicPath))) {
    baselineSection.push(new Paragraph({ text: "Baseline Schematic Screenshot", heading: HeadingLevel.HEADING_1 }));
    baselineSection.push(await imageParagraph(args.baselineSchematicPath, 720, 480, { fitMode: "auto" }));
  }

  const connectivitySection: Paragraph[] = [
    new Paragraph({ text: "Connectivity Schematic (Netlist-Derived)", heading: HeadingLevel.HEADING_1 }),
  ];
  if (args.connectivitySchematicPngPath && (await fs.pathExists(args.connectivitySchematicPngPath))) {
    // Connectivity diagrams can be very tall; ensure it fits on one page to avoid visual truncation in Word.
    connectivitySection.push(await imageParagraph(args.connectivitySchematicPngPath, 720, 480, { fitMode: "onePage" }));
  } else {
    connectivitySection.push(
      new Paragraph("Connectivity schematic image not generated (Graphviz 'dot' not found or netlist parse failed)."),
    );
  }

  const answersSection: Paragraph[] = [];
  const answers = (args.answers ?? []).filter((a) => a && (a.heading || a.markdown));
  if (answers.length) {
    answersSection.push(new Paragraph({ text: "Model Answers", heading: HeadingLevel.HEADING_1 }));
    for (const a of answers) {
      const heading = (a.heading || "Model").trim();
      const body = (a.markdown || "(No output)").trim();
      answersSection.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }));
      answersSection.push(...body.split(/\r?\n/).map((line) => new Paragraph(line)));
    }
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
          ...answersSection,
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

async function imageParagraph(
  pngPath: string,
  width: number,
  height: number,
  opts?: { fitMode?: "auto" | "onePage" },
): Promise<Paragraph> {
  const data = Buffer.from(await fs.readFile(pngPath));
  const imgType = imageTypeFromPath(pngPath);
  if (!imgType) {
    return new Paragraph(`Image format not supported for DOCX embedding: ${pngPath}`);
  }

  const intrinsic = imgType === "png" ? readPngSize(data) : imgType === "jpg" ? readJpegSize(data) : undefined;
  const target = intrinsic
    ? (() => {
        const mode = opts?.fitMode ?? "auto";
        if (mode === "onePage") return scaleToFit(intrinsic, width, height);

        // If the image is very tall relative to its width, fitting to page height makes it unreadable.
        // For those, fit to width only and keep aspect ratio.
        const aspect = intrinsic.height / Math.max(1, intrinsic.width);
        return aspect >= 1.8 ? scaleToFitWidth(intrinsic, width) : scaleToFit(intrinsic, width, height);
      })()
    : { width, height };

  const img = new ImageRun({
    type: imgType,
    data,
    transformation: target,
  });
  return new Paragraph({ children: [img] });
}
