/**
 * Shared display helpers for the Lay Bet Finder (singles) and Bet Builder
 * (multi-leg) pages. Pure functions only — no React, no side effects.
 */

export const SPORT_LABELS: Record<string, string> = {
  soccer: "Football",
  baseball: "Baseball",
  basketball: "Basketball",
  cricket: "Cricket",
  icehockey: "Ice Hockey",
  tennis: "Tennis",
  rugby: "Rugby",
  americanfootball: "American Football",
  aussierules: "Aussie Rules",
  golf: "Golf",
};

/** The category of a sport_key (the prefix before the first "_"). */
export function sportCategory(sportKey: string): string {
  return sportKey.split("_")[0];
}

export function sportLabel(cat: string): string {
  return SPORT_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
}

/**
 * Ice hockey is excluded everywhere: bookmaker back odds are for regulation
 * time while exchange lay odds are for overtime-inclusive results, so back and
 * lay never line up (owner directive — never show ice hockey as a layable row).
 */
export function isIceHockey(sportKey: string): boolean {
  return sportCategory(sportKey) === "icehockey";
}

export function getIcon(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return "⬆️";
  if (lower === away.toLowerCase()) return "⬇️";
  return "➡️";
}

/** Exact outcome in plain language — match result only (Home/Draw/Away in h2h). */
export function outcomePhrase(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return `${home} to beat ${away}`;
  if (lower === away.toLowerCase()) return `${away} to beat ${home}`;
  if (lower === "draw" || lower === "tie") return "Draw";
  return name;
}

export function money(n: number): string {
  return `£${n.toFixed(2)}`;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}
