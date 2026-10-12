import type { ReactNode } from "react";

/**
 * Minimal markdown renderer for the handful of constructs used in our
 * content files (headings, bold/italic, links, lists, tables, blockquotes,
 * horizontal rules). Good enough for guide pages — not a full Markdown engine.
 */

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={`s${k++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        nodes.push(
          <a key={`s${k++}`} href={lm[2]} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
            {lm[1]}
          </a>
        );
      } else {
        nodes.push(tok);
      }
    } else {
      nodes.push(<em key={`s${k++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const isHeading = (l: string) => /^#{1,3}\s+/.test(l);
const isHr = (l: string) => /^\s*---+\s*$/.test(l);
const isTable = (l: string) => l.trim().startsWith("|");
const isQuote = (l: string) => l.trim().startsWith(">");
const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);

export default function Markdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-6 border-gray-200 dark:border-gray-800" />);
      i++;
      continue;
    }

    if (isHeading(line)) {
      const m = line.match(/^(#{1,3})\s+(.*)$/)!;
      const level = m[1].length;
      const content = renderInline(m[2]);
      if (level === 1) {
        blocks.push(<h2 key={`b${key++}`} className="mt-8 text-2xl font-bold tracking-tight">{content}</h2>);
      } else if (level === 2) {
        blocks.push(<h3 key={`b${key++}`} className="mt-8 text-xl font-semibold">{content}</h3>);
      } else {
        blocks.push(<h4 key={`b${key++}`} className="mt-6 text-base font-semibold">{content}</h4>);
      }
      i++;
      continue;
    }

    if (isTable(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i])) {
        rows.push(
          lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
        );
        i++;
      }
      if (rows.length >= 2) {
        const header = rows[0];
        const body = rows.slice(2); // rows[1] is the |---| separator
        blocks.push(
          <div key={`b${key++}`} className="my-4 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm border-collapse">
              <thead>
                <tr className="border-b-2 border-gray-200 dark:border-gray-700">
                  {header.map((h, hi) => (
                    <th key={hi} className="py-2 pr-3 text-left font-semibold text-gray-700 dark:text-gray-200">
                      {renderInline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} className="border-b border-gray-100 dark:border-gray-800">
                    {row.map((cell, ci) => (
                      <td key={ci} className="py-2 pr-3 align-top text-gray-600 dark:text-gray-400">
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`} className="my-4 border-l-4 border-indigo-300 pl-4 text-gray-600 dark:text-gray-400">
          {quoteLines.map((q, qi) => (
            <p key={qi} className={qi > 0 ? "mt-2" : ""}>{renderInline(q)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`b${key++}`} className="my-4 list-disc pl-6 space-y-1 text-gray-600 dark:text-gray-400">
          {items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>)}
        </ul>
      );
      continue;
    }

    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`b${key++}`} className="my-4 list-decimal pl-6 space-y-1 text-gray-600 dark:text-gray-400">
          {items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>)}
        </ol>
      );
      continue;
    }

    // Paragraph: accumulate consecutive non-special lines
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeading(lines[i]) &&
      !isHr(lines[i]) &&
      !isTable(lines[i]) &&
      !isQuote(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={`b${key++}`} className="my-3 text-gray-600 dark:text-gray-400 leading-relaxed">
        {renderInline(para.join(" "))}
      </p>
    );
  }

  return <div>{blocks}</div>;
}
