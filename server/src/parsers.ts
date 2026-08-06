// Office document parsers for the file preview panel (docx / xlsx / pptx).

import mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface ParsedDoc {
  kind: "docx" | "xlsx" | "pptx";
  html?: string;
  sheets?: XlsxSheet[];
}

const MAX_XLSX_ROWS = 500;
const MAX_XLSX_COLS = 60;
const MAX_XLSX_SHEETS = 30;
const MAX_PPTX_SLIDES = 60;

export async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });
  return sanitizeHtml(result.value);
}

export function parseXlsx(buffer: Buffer): XlsxSheet[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets: XlsxSheet[] = [];
  for (const name of wb.SheetNames.slice(0, MAX_XLSX_SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    const rows = raw
      .slice(0, MAX_XLSX_ROWS)
      .map((r) => (Array.isArray(r) ? r : []).slice(0, MAX_XLSX_COLS).map((c) => (c == null ? "" : String(c))));
    sheets.push({ name, rows });
  }
  return sheets;
}

export async function parsePptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parts: string[] = [];
  for (let i = 0; i < slideNames.length && i < MAX_PPTX_SLIDES; i++) {
    const xml = await zip.files[slideNames[i]].async("string");
    const paras = extractParagraphs(xml);
    const body = paras.length
      ? paras.map((p) => `<p class="pptx-line">${escapeHtml(p)}</p>`).join("")
      : `<p class="pptx-empty">（本页无文本）</p>`;
    parts.push(`<section class="pptx-slide"><div class="pptx-slide-title">第 ${i + 1} 页</div>${body}</section>`);
  }
  if (parts.length === 0) throw new Error("未找到幻灯片内容（可能不是有效的 .pptx 文件）");
  return sanitizeHtml(parts.join(""));
}

function slideNumber(name: string): number {
  return parseInt(name.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
}

/** Extract the text runs of each <a:p> paragraph as a separate line. */
function extractParagraphs(xml: string): string[] {
  const out: string[] = [];
  const pRe = /<a:p>([\s\S]*?)<\/a:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(xml))) {
    const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
    const runs: string[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(pm[1]))) runs.push(tm[1]);
    const text = runs.join("").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Strip dangerous URL schemes from links/images before injecting as HTML. */
function sanitizeHtml(html: string): string {
  return html.replace(/\s(?:href|src)=["'](?:javascript|vbscript|data:text\/html)[^"']*["']/gi, ' href="#"');
}
