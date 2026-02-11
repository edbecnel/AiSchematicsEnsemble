import path from "node:path";
import fs from "fs-extra";
import PDFDocument from "pdfkit";
import { PNG } from "pngjs";

function contentWidth(doc: PDFKit.PDFDocument): number {
  const margins = doc.page.margins;
  return doc.page.width - (margins.left + margins.right);
}

function contentHeight(doc: PDFKit.PDFDocument): number {
  const margins = doc.page.margins;
  return doc.page.height - (margins.top + margins.bottom);
}

function sanitizeText(s: string): string {
  // Keep it simple; PDFKit handles unicode reasonably well.
  return String(s || "").replace(/\r\n/g, "\n");
}

function isPng(p: string): boolean {
  return path.extname(p).toLowerCase() === ".png";
}

async function readPng(p: string): Promise<PNG> {
  const data = await fs.readFile(p);
  return PNG.sync.read(data);
}

async function writePdf(doc: PDFKit.PDFDocument, outPath: string): Promise<void> {
  await fs.mkdirp(path.dirname(outPath));
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(outPath);
    stream.on("error", reject);
    doc.on("error", reject);
    stream.on("finish", () => resolve());

    doc.pipe(stream);
    doc.end();
  });
}

function heading(doc: PDFKit.PDFDocument, text: string, level: 1 | 2 | 3): void {
  const sizes = level === 1 ? 18 : level === 2 ? 14 : 12;
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(sizes).fillColor("black").text(text, { width: contentWidth(doc) });
  doc.moveDown(0.2);
}

function paragraph(doc: PDFKit.PDFDocument, text: string): void {
  doc.font("Helvetica").fontSize(10).fillColor("black").text(text, {
    width: contentWidth(doc),
    lineGap: 2,
  });
}

function codeBlock(doc: PDFKit.PDFDocument, lines: string[]): void {
  doc.font("Courier").fontSize(8).fillColor("black");
  for (const line of lines) {
    doc.text(line, { width: contentWidth(doc), lineGap: 1 });
  }
}

async function addPngWithPaging(doc: PDFKit.PDFDocument, pngPath: string, title: string): Promise<void> {
  heading(doc, title, 1);

  // Put the image(s) at the top of a fresh page for predictable paging.
  doc.addPage();

  const png = await readPng(pngPath);
  const maxW = contentWidth(doc);
  const maxH = contentHeight(doc);

  const scale = Math.min(maxW / png.width, 1);
  const targetW = Math.round(png.width * scale);
  const targetH = Math.round(png.height * scale);

  if (targetH <= maxH) {
    doc.image(pngPath, doc.page.margins.left, doc.page.margins.top, { width: targetW });
    return;
  }

  // The image is too tall even after scaling to fit width.
  // Slice it into multiple PNGs (source pixel bands) so each page shows a readable chunk.
  const sliceSrcH = Math.max(1, Math.floor(maxH / scale));

  let y = 0;
  while (y < png.height) {
    const h = Math.min(sliceSrcH, png.height - y);
    const slice = new PNG({ width: png.width, height: h });

    // Copy rows.
    const rowBytes = png.width * 4;
    for (let row = 0; row < h; row++) {
      const srcStart = (y + row) * rowBytes;
      const dstStart = row * rowBytes;
      png.data.copy(slice.data, dstStart, srcStart, srcStart + rowBytes);
    }

    const buf = PNG.sync.write(slice);

    // Start each slice on its own page.
    if (y !== 0) doc.addPage();

    doc.image(buf, doc.page.margins.left, doc.page.margins.top, { width: targetW });

    y += h;
  }
}

async function addImageBestEffort(doc: PDFKit.PDFDocument, imgPath: string, titleText: string): Promise<void> {
  const ext = path.extname(imgPath).toLowerCase();
  if (ext === ".png") {
    await addPngWithPaging(doc, imgPath, titleText);
    return;
  }

  // PDFKit supports JPEG natively. For other formats (webp/svg), skip with a note.
  if (ext === ".jpg" || ext === ".jpeg") {
    heading(doc, titleText, 1);
    doc.addPage();

    const maxW = contentWidth(doc);
    const maxH = contentHeight(doc);

    // Fit within page while preserving aspect ratio.
    doc.image(imgPath, doc.page.margins.left, doc.page.margins.top, { fit: [maxW, maxH] });
    return;
  }

  heading(doc, titleText, 1);
  paragraph(doc, `Image not embedded in PDF (unsupported format: ${ext}). See the run folder for: ${imgPath}`);
}

export async function writeReportPdf(args: {
  outPath: string;
  title: string;
  question: string;
  finalMarkdown: string;
  spiceNetlist: string;
  baselineSchematicPath?: string;
  connectivitySchematicPngPath?: string;
  answers?: Array<{ heading: string; markdown: string }>;
}): Promise<void> {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    autoFirstPage: true,
    compress: true,
  });

  // Title
  doc.font("Helvetica-Bold").fontSize(20).text(args.title, { width: contentWidth(doc) });
  doc.moveDown(0.8);

  // Question
  heading(doc, "Question", 1);
  paragraph(doc, sanitizeText(args.question));

  // Ensemble markdown
  heading(doc, "Ensembled Output (Markdown)", 1);
  for (const line of sanitizeText(args.finalMarkdown).split("\n")) {
    paragraph(doc, line);
  }

  // Model answers
  const answers = (args.answers ?? []).filter((a) => a && (a.heading || a.markdown));
  if (answers.length) {
    heading(doc, "Model Answers", 1);
    for (const a of answers) {
      heading(doc, sanitizeText(a.heading || "Model"), 2);
      for (const line of sanitizeText(a.markdown || "").split("\n")) {
        paragraph(doc, line);
      }
    }
  }

  // SPICE netlist
  heading(doc, "SPICE Netlist", 1);
  codeBlock(doc, sanitizeText(args.spiceNetlist).split("\n"));

  // Images
  if (args.baselineSchematicPath && (await fs.pathExists(args.baselineSchematicPath))) {
    await addImageBestEffort(doc, args.baselineSchematicPath, "Baseline Schematic Screenshot");
  }
  if (args.connectivitySchematicPngPath && (await fs.pathExists(args.connectivitySchematicPngPath))) {
    await addImageBestEffort(doc, args.connectivitySchematicPngPath, "Connectivity Schematic (Netlist-Derived)");
  }

  await writePdf(doc, args.outPath);
}
