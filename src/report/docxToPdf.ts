import path from "path";
import fs from "fs-extra";
import { execa } from "execa";

async function tryConvertWith(cmd: string, args: string[]): Promise<void> {
  await execa(cmd, args, { stdio: "ignore" });
}

export async function convertDocxToPdfViaLibreOffice(args: {
  docxPath: string;
  pdfOutPath: string;
}): Promise<{ ok: true; method: string } | { ok: false; reason: string }> {
  const docxPath = path.resolve(args.docxPath);
  const pdfOutPath = path.resolve(args.pdfOutPath);
  const outDir = path.dirname(pdfOutPath);

  if (!(await fs.pathExists(docxPath))) {
    return { ok: false, reason: `DOCX not found: ${docxPath}` };
  }

  await fs.ensureDir(outDir);

  // LibreOffice writes into outDir using the original basename.
  // We'll rename into pdfOutPath if needed.
  const expectedPdf = path.join(outDir, `${path.parse(docxPath).name}.pdf`);

  const attempts: Array<{ cmd: string; args: string[]; method: string }> = [
    {
      cmd: "soffice",
      args: ["--headless", "--nologo", "--nolockcheck", "--nodefault", "--norestore", "--convert-to", "pdf", "--outdir", outDir, docxPath],
      method: "soffice",
    },
    {
      cmd: "soffice.exe",
      args: ["--headless", "--nologo", "--nolockcheck", "--nodefault", "--norestore", "--convert-to", "pdf", "--outdir", outDir, docxPath],
      method: "soffice.exe",
    },
    {
      cmd: "libreoffice",
      args: ["--headless", "--nologo", "--nolockcheck", "--nodefault", "--norestore", "--convert-to", "pdf", "--outdir", outDir, docxPath],
      method: "libreoffice",
    },
  ];

  let lastError: unknown;
  for (const a of attempts) {
    try {
      await tryConvertWith(a.cmd, a.args);
      if (await fs.pathExists(expectedPdf)) {
        if (path.resolve(expectedPdf) !== pdfOutPath) {
          await fs.move(expectedPdf, pdfOutPath, { overwrite: true });
        }
        return { ok: true, method: a.method };
      }
      lastError = new Error(`Conversion reported success but PDF not found: ${expectedPdf}`);
    } catch (e) {
      lastError = e;
      continue;
    }
  }

  return { ok: false, reason: String((lastError as any)?.message ?? lastError ?? "LibreOffice conversion failed") };
}
