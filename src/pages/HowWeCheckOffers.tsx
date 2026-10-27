import { Link } from "react-router-dom";
import source from "../content/how-we-check-offers.md?raw";

/**
 * /how-we-check-offers — the approved copy in src/content/how-we-check-offers.md,
 * rendered as prose. A page that cites the Gambling Commission register has to
 * say how it does the checking, so this is linked from the offers panel.
 *
 * Rendered with a deliberately small formatter: headings, paragraphs, lists and
 * **bold**. No profit figure is introduced here, and the copy itself says the
 * checks cannot confirm an offer is live.
 */
type Block =
  | { kind: "h1" | "h2" | "p"; text: string }
  | { kind: "ol" | "ul"; items: string[] };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  let list: { kind: "ol" | "ul"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", text: para.join(" ") });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      blocks.push({ kind: "h2", text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      flushPara();
      flushList();
      blocks.push({ kind: "h1", text: line.slice(2) });
    } else if (/^\d+\.\s/.test(line)) {
      flushPara();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(line.replace(/^\d+\.\s/, ""));
    } else if (line.startsWith("- ")) {
      flushPara();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(line.slice(2));
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** **bold**, `code` and links-as-code, without pulling in a markdown library. */
function inline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-gray-900 dark:text-gray-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em] dark:bg-gray-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

const BLOCKS = parse(source);

export default function HowWeCheckOffers() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <section className="mx-auto max-w-3xl px-6 py-12">
        {BLOCKS.map((b, i) => {
          if (b.kind === "h1") {
            return (
              <h1 key={i} className="mb-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                {b.text}
              </h1>
            );
          }
          if (b.kind === "h2") {
            return (
              <h2 key={i} className="mt-8 mb-3 text-xl font-semibold text-gray-900 dark:text-gray-100">
                {b.text}
              </h2>
            );
          }
          if (b.kind === "p") {
            return (
              <p key={i} className="mb-4 text-sm leading-6 text-gray-600 dark:text-gray-400">
                {inline(b.text)}
              </p>
            );
          }
          const ListTag = b.kind === "ol" ? "ol" : "ul";
          return (
            <ListTag
              key={i}
              className={`mb-4 ml-5 space-y-2 text-sm leading-6 text-gray-600 dark:text-gray-400 ${
                b.kind === "ol" ? "list-decimal" : "list-disc"
              }`}
            >
              {b.items.map((it, j) => (
                <li key={j}>{inline(it)}</li>
              ))}
            </ListTag>
          );
        })}
        <p className="mt-10 border-t border-gray-200 pt-6 text-xs text-gray-400 dark:border-gray-800">
          18+ · begambleaware.org ·{" "}
          <Link to="/free-bets" className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
            the offers we list
          </Link>
        </p>
      </section>
    </div>
  );
}
