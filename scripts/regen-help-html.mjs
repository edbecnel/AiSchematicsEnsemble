import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const helpMdPath = path.resolve("Help.md");
const helpHtmlPath = path.resolve("help.html");

const html = await readFile(helpHtmlPath, "utf8");
const md = await readFile(helpMdPath, "utf8");

const newline = html.includes("\r\n") ? "\r\n" : "\n";
const mdNormalized = md.replace(/\r\n/g, "\n").replace(/\n/g, newline).trimEnd() + newline;

const re = /(<textarea\s+id="help-md"[^>]*>)([\s\S]*?)(<\/textarea\s*>)/m;
const match = html.match(re);

if (!match) {
  console.error(
    "Could not find <textarea id=\"help-md\"> block in help.html; aborting."
  );
  process.exit(1);
}

const current = match[2].replace(/^\s*\r?\n/, "");
const desired = mdNormalized;

const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  if (current === desired) {
    console.log("help.html is up to date.");
    process.exit(0);
  }
  console.error("help.html is out of date. Run: npm run regen:help-html");
  process.exit(2);
}

const nextHtml = html.replace(re, `$1${newline}${desired}$3`);

if (nextHtml === html) {
  console.log("No changes needed; help.html already up to date.");
  process.exit(0);
}

await writeFile(helpHtmlPath, nextHtml, "utf8");
console.log("Updated help.html from Help.md");
