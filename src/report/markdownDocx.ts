import MarkdownIt from "markdown-it";
import {
  ExternalHyperlink,
  HeadingLevel,
  Paragraph,
  TextRun,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";

type MdToken = {
  type: string;
  tag?: string;
  content?: string;
  attrs?: Array<[string, string]>;
  children?: MdToken[];
  attrGet?: (name: string) => string | null;
};

type ListKind = "bullet" | "ordered";

type RenderOptions = {
  headingDemotion?: number;
  maxHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
};

const md = new MarkdownIt({
  html: true,
  linkify: true,
});

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

type DocxHeading = NonNullable<IParagraphOptions["heading"]>;

function headingLevelFromTag(tag: string, demotion: number, max: 1 | 2 | 3 | 4 | 5 | 6): DocxHeading {
  const m = /^h([1-6])$/.exec(tag.toLowerCase());
  const nRaw = m ? Number(m[1]) : 1;
  const n = Math.min(max, Math.max(1, nRaw + demotion));
  switch (n) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    case 6:
      return HeadingLevel.HEADING_6;
    default:
      return HeadingLevel.HEADING_1;
  }
}

type InlineStyle = { bold: boolean; italics: boolean; code: boolean };

function renderInlineTokens(tokens: MdToken[] | null | undefined, initialStyle: InlineStyle): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  if (!tokens?.length) return out;

  const styleStack: InlineStyle[] = [initialStyle];
  const currentStyle = () => styleStack[styleStack.length - 1]!;

  let currentLinkHref: string | undefined;
  let linkRuns: TextRun[] = [];

  const flushLink = () => {
    if (currentLinkHref && linkRuns.length) {
      out.push(new ExternalHyperlink({ link: currentLinkHref, children: linkRuns }));
    } else {
      for (const r of linkRuns) out.push(r);
    }
    linkRuns = [];
  };

  const emitRun = (text: string, opts?: { forceCodeFont?: boolean; break?: number }) => {
    const cs = currentStyle();
    const run = new TextRun({
      text,
      bold: cs.bold || undefined,
      italics: cs.italics || undefined,
      font: cs.code || opts?.forceCodeFont ? "Consolas" : undefined,
      break: opts?.break,
    });

    if (currentLinkHref) linkRuns.push(run);
    else out.push(run);
  };

  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        emitRun(t.content ?? "");
        break;
      }
      case "softbreak":
      case "hardbreak": {
        emitRun("", { break: 1 });
        break;
      }
      case "code_inline": {
        emitRun(t.content ?? "", { forceCodeFont: true });
        break;
      }
      case "strong_open": {
        styleStack.push({ ...currentStyle(), bold: true });
        break;
      }
      case "strong_close": {
        if (styleStack.length > 1) styleStack.pop();
        break;
      }
      case "em_open": {
        styleStack.push({ ...currentStyle(), italics: true });
        break;
      }
      case "em_close": {
        if (styleStack.length > 1) styleStack.pop();
        break;
      }
      case "link_open": {
        flushLink();
        const hrefAttr = (t.attrs ?? []).find((attr: [string, string]) => attr[0] === "href");
        currentLinkHref = hrefAttr?.[1];
        break;
      }
      case "link_close": {
        flushLink();
        currentLinkHref = undefined;
        break;
      }
      case "html_inline": {
        const txt = stripHtmlTags(t.content ?? "");
        if (txt.trim()) emitRun(txt);
        break;
      }
      case "image": {
        const alt = t.attrGet?.("alt") || t.content || "image";
        emitRun(`[${alt}]`);
        break;
      }
      default: {
        const txt = stripHtmlTags(t.content ?? "");
        if (txt) emitRun(txt);
        break;
      }
    }
  }

  flushLink();
  return out;
}

function codeBlockParagraphs(code: string, indentTwips: number): Paragraph[] {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        indent: indentTwips ? { left: indentTwips } : undefined,
        children: [
          new TextRun({
            text: line,
            font: "Consolas",
          }),
        ],
      }),
  );
}

export function markdownToDocxParagraphs(markdown: string, opts?: RenderOptions): Paragraph[] {
  const headingDemotion = opts?.headingDemotion ?? 0;
  const maxHeadingLevel: 1 | 2 | 3 | 4 | 5 | 6 = opts?.maxHeadingLevel ?? 6;

  const tokens = md.parse(markdown ?? "", {}) as unknown as MdToken[];
  const paragraphs: Paragraph[] = [];

  const listStack: Array<{ kind: ListKind; nextIndex: number }> = [];
  const listItemStartedStack: boolean[] = [];
  let blockquoteDepth = 0;

  const currentList = () => (listStack.length ? listStack[listStack.length - 1] : undefined);
  const listLevel = () => Math.max(0, listStack.length - 1);

  let pendingHeading: { level: DocxHeading } | undefined;
  let pendingParagraphRuns: ParagraphChild[] | undefined;

  const finalizeParagraph = (runs: ParagraphChild[], extra?: Partial<IParagraphOptions>) => {
    const indentBase = blockquoteDepth ? 720 * blockquoteDepth : 0;
    const list = currentList();
    const inListItem = listItemStartedStack.length > 0;

    const indentLeft = indentBase + (inListItem ? 720 * (listLevel() + 1) : 0);

    const options: IParagraphOptions = {
      children: runs,
      indent: indentLeft ? { left: indentLeft, hanging: inListItem ? 360 : undefined } : undefined,
      ...extra,
    };

    paragraphs.push(new Paragraph(options));
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (t.type === "blockquote_open") {
      blockquoteDepth++;
      continue;
    }
    if (t.type === "blockquote_close") {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1);
      continue;
    }

    if (t.type === "bullet_list_open") {
      listStack.push({ kind: "bullet", nextIndex: 1 });
      continue;
    }
    if (t.type === "bullet_list_close") {
      listStack.pop();
      continue;
    }

    if (t.type === "ordered_list_open") {
      listStack.push({ kind: "ordered", nextIndex: 1 });
      continue;
    }
    if (t.type === "ordered_list_close") {
      listStack.pop();
      continue;
    }

    if (t.type === "list_item_open") {
      listItemStartedStack.push(false);
      continue;
    }
    if (t.type === "list_item_close") {
      listItemStartedStack.pop();
      continue;
    }

    if (t.type === "heading_open") {
      pendingHeading = { level: headingLevelFromTag(t.tag ?? "h1", headingDemotion, maxHeadingLevel) };
      continue;
    }
    if (t.type === "heading_close") {
      pendingHeading = undefined;
      continue;
    }

    if (t.type === "paragraph_open") {
      pendingParagraphRuns = [];
      continue;
    }

    if (t.type === "inline") {
      const inlineRuns = renderInlineTokens(t.children, { bold: false, italics: false, code: false });

      if (pendingParagraphRuns) {
        pendingParagraphRuns.push(...inlineRuns);
      } else if (pendingHeading) {
        finalizeParagraph(inlineRuns, { heading: pendingHeading.level });
      } else {
        finalizeParagraph(inlineRuns);
      }
      continue;
    }

    if (t.type === "paragraph_close") {
      const runs = pendingParagraphRuns ?? [];
      pendingParagraphRuns = undefined;

      const list = currentList();
      const inListItem = listItemStartedStack.length > 0;

      if (inListItem && list) {
        const alreadyStarted = listItemStartedStack[listItemStartedStack.length - 1] ?? false;
        if (!alreadyStarted) {
          listItemStartedStack[listItemStartedStack.length - 1] = true;

          if (list.kind === "ordered") {
            const idx = list.nextIndex++;
            runs.unshift(new TextRun({ text: `${idx}. ` }));
          }
        }

        if (list.kind === "bullet") {
          finalizeParagraph(runs, { bullet: { level: listLevel() } });
        } else {
          finalizeParagraph(runs);
        }
      } else {
        finalizeParagraph(runs);
      }

      continue;
    }

    if (t.type === "fence" || t.type === "code_block") {
      const indentTwips = (blockquoteDepth ? 720 * blockquoteDepth : 0) + (listItemStartedStack.length ? 720 * (listLevel() + 1) : 0);
      paragraphs.push(...codeBlockParagraphs(t.content ?? "", indentTwips));
      continue;
    }

    if (t.type === "hr") {
      paragraphs.push(new Paragraph("—"));
      continue;
    }

    if (t.type === "html_block") {
      const txt = stripHtmlTags(t.content ?? "").trim();
      if (txt) paragraphs.push(new Paragraph(txt));
      continue;
    }
  }

  // Ensure Word doesn't end with an empty section if markdown is empty
  if (!paragraphs.length) paragraphs.push(new Paragraph(""));

  return paragraphs;
}
