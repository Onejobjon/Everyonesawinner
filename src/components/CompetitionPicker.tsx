/**
 * The competition picker — a compact control, not a wall of checkboxes.
 *
 * WHY (owner, 2026-11-04: "the list of sports needs gone"). The old picker
 * rendered all 81 competitions from the provider catalogue as grouped checkbox
 * lists, football expanded by default: on a phone that was several screens of
 * boxes before you reached the search button. This replaces it with:
 *
 *   one summary line  →  removable chips for what is chosen  →  a search box
 *   that filters the catalogue as you type (capped at 8 results).
 *
 * It is INLINE expand/collapse (no route change), collapsed by default, and it
 * owns no state that matters: `selected` lives in the page, so the saved-controls
 * shape (v2: {stake, minOdds, leagues, dayMode, dayDate}) is untouched.
 */
import { useMemo, useRef, useState } from "react";

export interface PickerSport {
  key: string;
  label: string;
  group: string;
}

interface CompetitionPickerProps {
  sports: PickerSport[];
  selected: string[];
  /** The most competitions one search may cover. */
  max: number;
  /** Add or remove one competition. */
  onToggle: (key: string) => void;
  onReset: () => void;
  /** What the reset button restores, e.g. "EPL, Championship & Champions League". */
  resetLabel?: string;
}

/** How many search results are shown at once before "keep typing". */
const RESULT_CAP = 8;

/** The provider groups football under "Soccer"; say what the user calls it. */
const GROUP_LABELS: Record<string, string> = { Soccer: "Football" };

function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

export default function CompetitionPicker({
  sports,
  selected,
  max,
  onToggle,
  onReset,
  resetLabel,
}: CompetitionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const byKey = useMemo(() => new Map(sports.map((s) => [s.key, s])), [sports]);
  const atCap = selected.length >= max;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Already-chosen competitions are shown as chips, so they are not offered
    // again in the list — tapping one twice would be a no-op the user can't see.
    const pool = sports.filter((s) => !selected.includes(s.key));
    const hits = q
      ? pool.filter(
          (s) =>
            s.label.toLowerCase().includes(q) ||
            s.group.toLowerCase().includes(q) ||
            groupLabel(s.group).toLowerCase().includes(q),
        )
      : pool;
    // Football first — it is what this tool is for — then everything else A–Z.
    const ordered = [...hits].sort((a, b) => {
      const aFootball = a.group === "Soccer" ? 0 : 1;
      const bFootball = b.group === "Soccer" ? 0 : 1;
      if (aFootball !== bFootball) return aFootball - bFootball;
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return a.label.localeCompare(b.label);
    });
    return { total: ordered.length, shown: ordered.slice(0, RESULT_CAP) };
  }, [sports, selected, query]);

  const summary =
    selected.length === 0
      ? `No competitions selected — choose up to ${max}`
      : `${selected.length} of ${max} competitions selected`;

  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Competitions to search</h2>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400" role="status">
            {summary}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="competition-picker-panel"
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
        >
          {open ? "Done" : selected.length === 0 ? "Choose competitions" : "Change"}
        </button>
      </div>

      {selected.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {selected.map((key) => {
            const sport = byKey.get(key);
            if (!sport) return null;
            return (
              <li key={key} className="max-w-full">
                <button
                  type="button"
                  onClick={() => onToggle(key)}
                  aria-label={`Remove ${sport.label}`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
                >
                  <span className="truncate">{sport.label}</span>
                  <span aria-hidden="true" className="text-sm leading-none text-indigo-400">×</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div id="competition-picker-panel" className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <label className="block">
            <span className="sr-only">Search competitions</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="Search competitions — football, EPL, tennis…"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:placeholder:text-gray-500 dark:focus:ring-indigo-900"
            />
          </label>

          {atCap ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              That is the most one search covers ({max} competitions). Remove one above to swap it for
              another.
            </p>
          ) : (
            <>
              {matches.shown.length > 0 ? (
                <ul className="mt-2 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {matches.shown.map((s) => (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => onToggle(s.key)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                      >
                        <span className="min-w-0 truncate font-medium text-gray-800 dark:text-gray-100">
                          {s.label}
                        </span>
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          {groupLabel(s.group)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 rounded-lg border border-gray-200 px-3 py-3 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  No competition matches “{query}”. Try a shorter word — “football”, “tennis”, “league”.
                </p>
              )}
              {matches.total > matches.shown.length && (
                <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                  Showing {matches.shown.length} of {matches.total} — keep typing to narrow it down.
                </p>
              )}
            </>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-gray-400 dark:text-gray-500">Tap a competition to add it.</p>
            <button
              type="button"
              onClick={onReset}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              {resetLabel ? `Reset to ${resetLabel}` : "Reset"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
