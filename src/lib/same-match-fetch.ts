/**
 * The client half of /same-match: ONE match's markets, fetched only when the
 * user clicks, and parsed by the shared tested parser in ./same-match.
 *
 * Credit discipline is the reason this module is so small and so explicit:
 *   • the market list is built from the SAME allow-list the server enforces, so
 *     the stated cost is the real cost;
 *   • the cost is returned alongside the data so the page can show what was
 *     actually spent (the provider's own header) rather than what we assumed;
 *   • nothing here is called on mount. No fetch, no credits.
 */
import { parseEventMarkets, type EventMarkets } from "./same-match";

/**
 * The markets the planner reads. Each one is a separate credit on the per-event
 * endpoint (billed per market, per region), which is why they are named one by
 * one rather than assembled from a wish-list.
 */
export const BASE_MARKETS = ["h2h", "btts", "totals"] as const;
/** Opt-in: home/away goal lines. +1 credit. */
export const TEAM_TOTALS_MARKET = "team_totals" as const;
/** Opt-in: correct-score BACK prices, used only as a labelled benchmark. +1 credit. */
export const REFERENCE_MARKET = "correct_score" as const;

export interface MarketRequest {
  eventId: string;
  sportKey: string;
  /** Include home/away team goal lines (+1 credit). */
  includeTeamTotals: boolean;
  /** Include correct-score back prices for the reference column (+1 credit). */
  includeReference: boolean;
}

/** The markets a request will ask for, in the order they are sent. */
export function marketsFor(req: Pick<MarketRequest, "includeTeamTotals" | "includeReference">): string[] {
  const markets: string[] = [...BASE_MARKETS];
  if (req.includeTeamTotals) markets.push(TEAM_TOTALS_MARKET);
  if (req.includeReference) markets.push(REFERENCE_MARKET);
  return markets;
}

/** What the request will cost, in credits, before it is sent. */
export function creditsFor(req: Pick<MarketRequest, "includeTeamTotals" | "includeReference">): number {
  // 1 credit per market (measured on the per-event endpoint).
  return marketsFor(req).length;
}

export interface SameMatchFetchResult {
  event: EventMarkets;
  marketsRequested: string[];
  credits: {
    perMarket: number;
    spent: number;
    remaining: number | null;
    measured: boolean;
  };
  fetchedAt: string;
}

/** The session token this browser holds (the server verifies it, not us). */
function sessionToken(): string {
  try {
    const stored = localStorage.getItem("eaw_session");
    if (!stored) return "";
    const parsed = JSON.parse(stored) as { token?: unknown };
    return typeof parsed?.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

/**
 * Fetch one match's markets. Throws only when the fetch itself could not run;
 * a provider error comes back as a thrown Error carrying the server's plain
 * language, because there is nothing partial to show for a single event.
 */
export async function fetchMatchMarkets(req: MarketRequest): Promise<SameMatchFetchResult> {
  if (!req.eventId || !req.sportKey) {
    throw new Error("Pick one fixture first — this fetch covers exactly one match.");
  }
  const markets = marketsFor(req);
  const url =
    `/api/same-match?event=${encodeURIComponent(req.eventId)}` +
    `&sport=${encodeURIComponent(req.sportKey)}` +
    `&markets=${encodeURIComponent(markets.join(","))}`;

  const token = sessionToken();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, cache: "no-store" });
  let payload: {
    ok?: boolean;
    event?: unknown;
    markets?: string[];
    credits?: { perMarket?: number; spent?: number; remaining?: number | null; measured?: boolean };
    fetchedAt?: string;
    error?: string;
    message?: string;
  } | null = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.ok === false) {
    throw new Error(
      payload?.message ||
        (payload == null
          ? // A non-JSON reply means the fetch endpoint is not being served by
            // this host yet — say so plainly instead of leaking a status code.
            "The server did not return market data for this match. Nothing was charged — try again in a moment."
          : res.status === 403
            ? "This is a Pro tool — upgrade to Pro to fetch a match."
            : res.status === 401
              ? "Sign in again to fetch a match. Nothing was charged."
              : `The fetch could not run (${res.status}). Nothing was charged.`)
    );
  }

  const event = parseEventMarkets(payload.event);
  const credits = payload.credits ?? {};
  return {
    event,
    marketsRequested: Array.isArray(payload.markets) ? payload.markets : markets,
    credits: {
      perMarket: typeof credits.perMarket === "number" ? credits.perMarket : 1,
      spent: typeof credits.spent === "number" ? credits.spent : markets.length,
      remaining: typeof credits.remaining === "number" ? credits.remaining : null,
      measured: Boolean(credits.measured),
    },
    fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
  };
}
