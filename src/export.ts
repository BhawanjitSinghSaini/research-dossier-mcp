import { marked, type Token, type Tokens } from "marked";
import PDFDocument from "pdfkit";

export interface SlideOutline {
  slides: { title: string; content: string[]; notes: string }[];
}

export type ExportResult =
  | { kind: "text"; text: string }
  | { kind: "pdf"; buffer: Buffer }
  | { kind: "json"; text: string };

/** Dispatches a synthesized dossier to the requested export format. */
export async function exportDossier(
  dossier: string,
  format: string
): Promise<ExportResult> {
  switch (format) {
    case "pdf-outline":
      return { kind: "pdf", buffer: await markdownToPdf(dossier) };
    case "slide-outline":
      return { kind: "json", text: JSON.stringify(markdownToSlides(dossier), null, 2) };
    case "markdown":
    default:
      return { kind: "text", text: dossier };
  }
}

const FONT = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  boldItalic: "Helvetica-BoldOblique",
  mono: "Courier",
} as const;

const HEADING_SIZES = [24, 20, 16, 14, 12, 11];

/** Renders a markdown dossier into a styled PDF, preserving headings, lists, tables, and inline emphasis. */
export function markdownToPdf(markdown: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, autoFirstPage: true, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font(FONT.regular).fontSize(11);

    try {
      for (const token of marked.lexer(markdown)) {
        renderBlock(doc, token);
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    doc.end();
  });
}

function renderBlock(doc: PDFKit.PDFDocument, token: Token): void {
  switch (token.type) {
    case "heading": {
      const size = HEADING_SIZES[Math.min(token.depth - 1, HEADING_SIZES.length - 1)];
      doc.moveDown(0.6);
      doc.font(FONT.bold).fontSize(size);
      renderInline(doc, token.tokens ?? [{ type: "text", raw: token.text, text: token.text } as Tokens.Text], {
        bold: true,
        size,
      });
      doc.moveDown(0.3);
      doc.font(FONT.regular).fontSize(11);
      break;
    }
    case "paragraph": {
      renderInline(doc, token.tokens ?? [], { size: 11 });
      doc.moveDown(0.5);
      break;
    }
    case "list": {
      renderList(doc, token as Tokens.List, 0);
      doc.moveDown(0.4);
      break;
    }
    case "table": {
      renderTable(doc, token as Tokens.Table);
      doc.moveDown(0.5);
      break;
    }
    case "blockquote": {
      const x = doc.x;
      doc.font(FONT.italic).fontSize(11);
      for (const child of (token as Tokens.Blockquote).tokens) {
        if (child.type === "paragraph") {
          renderInline(doc, child.tokens ?? [], { italic: true, size: 11, indent: 16 });
        }
      }
      doc.font(FONT.regular);
      doc.x = x;
      doc.moveDown(0.4);
      break;
    }
    case "code": {
      const code = (token as Tokens.Code).text;
      doc.font(FONT.mono).fontSize(9);
      const startY = doc.y;
      const height = doc.heightOfString(code, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 16 }) + 12;
      doc
        .rect(doc.x - 4, startY - 4, doc.page.width - doc.page.margins.left - doc.page.margins.right + 8, height)
        .fill("#f2f2f2");
      doc.fillColor("#000000").text(code, doc.x, startY, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 16 });
      doc.font(FONT.regular).fontSize(11);
      doc.moveDown(0.5);
      break;
    }
    case "hr": {
      doc
        .moveDown(0.3)
        .strokeColor("#cccccc")
        .moveTo(doc.x, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke()
        .strokeColor("#000000");
      doc.moveDown(0.5);
      break;
    }
    case "space":
      break;
    default: {
      if ("text" in token && typeof token.text === "string" && token.text.trim()) {
        doc.font(FONT.regular).fontSize(11).text(token.text);
        doc.moveDown(0.3);
      }
      break;
    }
  }

  if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
    // pdfkit auto-paginates on overflow within text/rect calls, but guard against
    // leaving the cursor stranded right at the page edge after non-text draws (e.g. hr).
  }
}

function renderList(doc: PDFKit.PDFDocument, list: Tokens.List, depth: number): void {
  const startX = doc.page.margins.left;
  let index = list.start && typeof list.start === "number" ? list.start : 1;
  for (const item of list.items) {
    const marker = list.ordered ? `${index}. ` : "• ";
    index++;
    const indent = 16 + depth * 16;
    doc.font(FONT.regular).fontSize(11);
    doc.text(marker, startX + indent, doc.y, { continued: true });

    const inlineTokens = item.tokens.filter((t) => t.type !== "list");
    const nestedLists = item.tokens.filter((t): t is Tokens.List => t.type === "list");

    const flat =
      inlineTokens.length === 1 && inlineTokens[0].type === "text"
        ? flattenInline(
            (inlineTokens[0] as Tokens.Text).tokens ?? [
              { type: "text", raw: (inlineTokens[0] as Tokens.Text).text, text: (inlineTokens[0] as Tokens.Text).text } as Tokens.Text,
            ],
            false,
            false
          )
        : [];

    if (flat.length === 0) {
      doc.text("", { continued: false });
    } else {
      flat.forEach((seg, i) => {
        doc.font(fontFor(seg.bold, seg.italic)).fontSize(11);
        if (seg.link) doc.fillColor("#1a5fb4");
        doc.text(seg.text, { continued: i < flat.length - 1 });
        if (seg.link) doc.fillColor("#000000");
      });
    }
    doc.x = startX;

    for (const nested of nestedLists) {
      renderList(doc, nested, depth + 1);
    }
  }
}

interface InlineOpts {
  bold?: boolean;
  italic?: boolean;
  size: number;
  indent?: number;
}

function fontFor(bold: boolean, italic: boolean): string {
  if (bold && italic) return FONT.boldItalic;
  if (bold) return FONT.bold;
  if (italic) return FONT.italic;
  return FONT.regular;
}

function renderInline(doc: PDFKit.PDFDocument, tokens: Token[], opts: InlineOpts): void {
  if (opts.indent) doc.x += opts.indent;
  const flat = flattenInline(tokens, !!opts.bold, !!opts.italic);
  if (flat.length === 0) {
    doc.text("", { continued: false });
    return;
  }
  flat.forEach((seg, i) => {
    doc.font(fontFor(seg.bold, seg.italic)).fontSize(opts.size);
    if (seg.link) doc.fillColor("#1a5fb4");
    doc.text(seg.text, { continued: i < flat.length - 1 });
    if (seg.link) doc.fillColor("#000000");
  });
}

interface FlatSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  link?: boolean;
}

function flattenInline(tokens: Token[], bold: boolean, italic: boolean): FlatSegment[] {
  const out: FlatSegment[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
      case "escape":
        out.push({ text: (tok as Tokens.Text).text, bold, italic });
        break;
      case "strong":
        out.push(...flattenInline((tok as Tokens.Strong).tokens, true, italic));
        break;
      case "em":
        out.push(...flattenInline((tok as Tokens.Em).tokens, bold, true));
        break;
      case "codespan":
        out.push({ text: (tok as Tokens.Codespan).text, bold, italic });
        break;
      case "link": {
        const link = tok as Tokens.Link;
        // marked's GFM autolinker greedily swallows a trailing "]" into the URL when a bare
        // link sits inside brackets (our own "[Source: URL]" citation format triggers this) —
        // split it back out as trailing plain text instead of baking it into the href.
        let href = link.href;
        let label = link.text;
        let trailing = "";
        if (href.endsWith("]") && !href.slice(0, -1).includes("]")) {
          href = href.slice(0, -1);
          if (label.endsWith("]")) label = label.slice(0, -1);
          trailing = "]";
        }
        const display = label === href ? label : `${label} (${href})`;
        out.push({ text: display, bold, italic, link: true });
        if (trailing) out.push({ text: trailing, bold, italic });
        break;
      }
      case "br":
        out.push({ text: "\n", bold, italic });
        break;
      default:
        if ("text" in tok && typeof (tok as { text?: string }).text === "string") {
          out.push({ text: (tok as { text: string }).text, bold, italic });
        }
    }
  }
  return out;
}

function renderTable(doc: PDFKit.PDFDocument, table: Tokens.Table): void {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = table.header.length;
  const colWidth = usableWidth / cols;
  const startX = doc.x;

  const drawRow = (cells: { text: string }[], bold: boolean) => {
    const y = doc.y;
    let maxHeight = 0;
    cells.forEach((cell, i) => {
      const h = doc.heightOfString(cell.text, { width: colWidth - 8 });
      if (h > maxHeight) maxHeight = h;
    });
    cells.forEach((cell, i) => {
      doc
        .font(bold ? FONT.bold : FONT.regular)
        .fontSize(10)
        .text(cell.text, startX + i * colWidth, y, { width: colWidth - 8 });
    });
    doc.y = y + maxHeight + 6;
    doc.x = startX;
  };

  drawRow(
    table.header.map((h) => ({ text: h.text })),
    true
  );
  doc
    .strokeColor("#999999")
    .moveTo(startX, doc.y)
    .lineTo(startX + usableWidth, doc.y)
    .stroke()
    .strokeColor("#000000");
  doc.moveDown(0.3);

  for (const row of table.rows) {
    drawRow(
      row.map((c) => ({ text: c.text })),
      false
    );
  }
}

/** Parses a markdown dossier into a slide-deck outline: H1 starts a new slide, H2 marks a section within it. */
export function markdownToSlides(markdown: string): SlideOutline {
  const tokens = marked.lexer(markdown);
  const slides: SlideOutline["slides"] = [];
  let current: SlideOutline["slides"][number] | null = null;

  const ensureSlide = (title: string) => {
    current = { title, content: [], notes: "" };
    slides.push(current);
  };

  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 1) {
      ensureSlide(token.text);
      continue;
    }
    if (token.type === "heading" && token.depth === 2) {
      if (!current) ensureSlide("Overview");
      current!.content.push(`## ${token.text}`);
      continue;
    }
    if (token.type === "space") continue;

    const text = blockToPlainText(token);
    if (!text) continue;
    if (!current) ensureSlide("Overview");
    current!.content.push(text);
  }

  return { slides };
}

function blockToPlainText(token: Token): string {
  switch (token.type) {
    case "heading":
      return `${"#".repeat(token.depth)} ${token.text}`;
    case "paragraph":
      return token.text;
    case "list": {
      const list = token as Tokens.List;
      return list.items
        .map((item, i) => `${list.ordered ? `${i + 1}.` : "-"} ${item.text}`)
        .join("\n");
    }
    case "table": {
      const t = token as Tokens.Table;
      const header = t.header.map((h) => h.text).join(" | ");
      const rows = t.rows.map((r) => r.map((c) => c.text).join(" | "));
      return [header, ...rows].join("\n");
    }
    case "blockquote":
      return token.text;
    case "code":
      return (token as Tokens.Code).text;
    case "hr":
      return "";
    default:
      return "text" in token && typeof (token as { text?: string }).text === "string"
        ? (token as { text: string }).text
        : "";
  }
}
