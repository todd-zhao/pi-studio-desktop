// Minimal Markdown renderer (no external deps).
import React, { Fragment, type ReactNode } from "react";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Token {
  type: string;
  content?: string;
  lang?: string;
  items?: Token[];
  href?: string;
  align?: string;
  rows?: string[][];
}

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // code spans first
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <code key={i} className="md-code">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part) {
      // bold / italic / links
      const tokens = part.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
      tokens.forEach((tok, j) => {
        if (tok.startsWith("**") && tok.endsWith("**")) {
          nodes.push(<strong key={`${i}-${j}`}>{tok.slice(2, -2)}</strong>);
        } else if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
          nodes.push(<em key={`${i}-${j}`}>{tok.slice(1, -1)}</em>);
        } else if (tok.startsWith("[") && tok.includes("](")) {
          const m = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
          if (m) {
            const href = m[2].startsWith("http") ? m[2] : m[2];
            nodes.push(
              <a key={`${i}-${j}`} href={href} target="_blank" rel="noreferrer">
                {m[1]}
              </a>,
            );
          }
        } else if (tok) {
          nodes.push(<Fragment key={`${i}-${j}`}>{tok}</Fragment>);
        }
      });
    }
  });
  return nodes;
}

function renderInline(text: string): ReactNode {
  return <>{parseInline(text)}</>;
}

function pipeCount(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function parseBlocks(src: string): Token[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const tokens: Token[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      tokens.push({ type: "code", content: buf.join("\n"), lang });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      tokens.push({ type: `h${h[1].length}`, content: h[2] });
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      tokens.push({ type: "hr", content: "" });
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      tokens.push({ type: "quote", content: buf.join("\n") });
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Token[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push({ type: "li", content: lines[i].replace(/^\s*[-*+]\s+/, "") });
        i++;
      }
      tokens.push({ type: "ul", items });
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Token[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push({ type: "li", content: lines[i].replace(/^\s*\d+[.)]\s+/, "") });
        i++;
      }
      tokens.push({ type: "ol", items });
      continue;
    }

    // table (separator optional; AI output sometimes omits the alignment row)
    const hasTableSeparator = i + 1 < lines.length && isTableSeparator(lines[i + 1]);
    const looksLikeTable = line.includes("|") && i + 1 < lines.length &&
      (hasTableSeparator || (pipeCount(line) >= 2 && lines[i + 1].includes("|")));
    if (looksLikeTable) {
      const header = line
        .split("|")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const aligns = hasTableSeparator ? lines[i + 1]
        .split("|")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => (s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : s.startsWith(":") ? "left" : "left")) : [];
      const rows: string[][] = [];
      i += hasTableSeparator ? 2 : 1;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(
          lines[i]
            .split("|")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
        );
        i++;
      }
      tokens.push({ type: "table", content: "", rows: [header, ...rows], align: aligns.join(",") });
      continue;
    }

    // blank
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph: collect until blank
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|```|>\s|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    tokens.push({ type: "p", content: buf.join(" ") });
  }
  return tokens;
}

function CodeBlock({ content, lang }: { content: string; lang?: string }) {
  const copy = () => {
    void navigator.clipboard?.writeText(content);
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span>{lang || "text"}</span>
        <button onClick={copy}>复制</button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

function renderToken(tok: Token, key: number): ReactNode {
  switch (tok.type) {
    case "p":
      return <p key={key}>{renderInline(tok.content ?? "")}</p>;
    case "h1":
      return <h1 key={key}>{renderInline(tok.content ?? "")}</h1>;
    case "h2":
      return <h2 key={key}>{renderInline(tok.content ?? "")}</h2>;
    case "h3":
      return <h3 key={key}>{renderInline(tok.content ?? "")}</h3>;
    case "h4":
    case "h5":
    case "h6":
      return <h4 key={key}>{renderInline(tok.content ?? "")}</h4>;
    case "hr":
      return <hr key={key} />;
    case "quote":
      return <blockquote key={key}>{renderInline(tok.content ?? "")}</blockquote>;
    case "code":
      return <CodeBlock key={key} content={tok.content ?? ""} lang={tok.lang} />;
    case "ul":
      return (
        <ul key={key}>
          {(tok.items ?? []).map((it, j) => (
            <li key={j}>{renderInline(it.content ?? "")}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {(tok.items ?? []).map((it, j) => (
            <li key={j}>{renderInline(it.content ?? "")}</li>
          ))}
        </ol>
      );
    case "table": {
      const rows = tok.rows ?? [];
      const aligns = (tok.align ?? "").split(",");
      return (
        <div className="md-table-wrap" key={key}>
          <table>
            {rows.length > 0 && (
              <thead>
                <tr>
                  {rows[0].map((c, i) => (
                    <th key={i} style={{ textAlign: aligns[i] as "left" }}>
                      {renderInline(c ?? "")}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.slice(1).map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] as "left" }}>
                      {renderInline(c ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

export function Markdown({ text }: { text: string }) {
  const tokens = parseBlocks(text || "");
  return <div className="md">{tokens.map(renderToken)}</div>;
}

export function stripMarkdown(text: string): string {
  return escapeHtml(text.replace(/```[\s\S]*?```/g, "[代码]").replace(/`/g, "").replace(/[*_>#]/g, "")).slice(0, 400);
}
