// Oddsmatcher engine — uses simulated data for now, ready to swap to live Odds API
// When ODDS_API_KEY env var is set, it will fetch from the-odds-api.com

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

export interface Match {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  isWorldCup: boolean;
  outcomes: Outcome[];
  bestArbitrage?: ArbitrageOpportunity;
}

export interface Outcome {
  name: string;
  backOdds: BookmakerOdds[];
  layOdds: LayOdds | null;
}

export interface BookmakerOdds {
  bookmaker: string;
  odds: number;
}

export interface LayOdds {
  exchange: string;
  odds: number;
}

export interface ArbitrageOpportunity {
  backBookmaker: string;
  layExchange: string;
  outcomeName: string;
  profitPercent: number;
  isProfitable: boolean;
}

// WC2026 mock data
const WC_TEAMS = [
  "USA", "Mexico", "Canada", "Brazil", "Argentina", "Uruguay", "England",
  "France", "Germany", "Spain", "Portugal", "Netherlands", "Italy",
  "Japan", "South Korea", "Australia", "Morocco", "Senegal", "Ghana",
  "Nigeria", "Saudi Arabia", "Iran", "Croatia", "Belgium", "Denmark",
  "Switzerland", "Poland", "Colombia", "Ecuador", "Chile", "Paraguay", "Costa Rica",
];

const BOOKMAKERS = ["Bet365", "William Hill", "Paddy Power", "Betfair Sportsbook", "Sky Bet", "Unibet"];
const EXCHANGES = ["Betfair Exchange", "Smarkets"];

function shuffleTeams(): [string, string] {
  const shuffled = [...WC_TEAMS].sort(() => Math.random() - 0.5);
  const idx = Math.floor(Math.random() * shuffled.length / 2) * 2;
  return [shuffled[idx % shuffled.length], shuffled[(idx + 1) % shuffled.length]];
}

function randomOdds(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function generateMatch(id: number, isWC: boolean): Match {
  const [home, away] = shuffleTeams();
  const now = new Date();
  const daysFromNow = Math.floor(Math.random() * 14) + 1;
  const hoursFromNow = Math.floor(Math.random() * 24);
  const commenceTime = new Date(now.getTime() + (daysFromNow * 24 + hoursFromNow) * 60 * 60 * 1000);

  // Home win / Draw / Away win odds
  const homeOdds = randomOdds(1.5, 6.0);
  const drawOdds = randomOdds(2.5, 4.5);
  const awayOdds = randomOdds(1.5, 6.0);

  const outcomes: Outcome[] = [
    {
      name: `${home} (Home)`,
      backOdds: BOOKMAKERS.map((bm) => ({
        bookmaker: bm,
        odds: homeOdds + (Math.random() - 0.5) * 0.3,
      })),
      layOdds: {
        exchange: "Betfair Exchange",
        odds: homeOdds + 0.05 + Math.random() * 0.15,
      },
    },
    {
      name: "Draw",
      backOdds: BOOKMAKERS.map((bm) => ({
        bookmaker: bm,
        odds: drawOdds + (Math.random() - 0.5) * 0.2,
      })),
      layOdds: {
        exchange: "Betfair Exchange",
        odds: drawOdds + 0.03 + Math.random() * 0.12,
      },
    },
    {
      name: `${away} (Away)`,
      backOdds: BOOKMAKERS.map((bm) => ({
        bookmaker: bm,
        odds: awayOdds + (Math.random() - 0.5) * 0.3,
      })),
      layOdds: {
        exchange: "Betfair Exchange",
        odds: awayOdds + 0.05 + Math.random() * 0.15,
      },
    },
  ];

  // Find best arbitrage
  let bestArb: ArbitrageOpportunity | null = null;
  for (const outcome of outcomes) {
    const bestBack = outcome.backOdds.reduce((a, b) => (a.odds > b.odds ? a : b));
    if (outcome.layOdds) {
      // For a qualifying bet: profit % = (backOdds - layOdds) / layOdds * 100 (simplified)
      // With 2% commission on lay
      const effectiveLay = outcome.layOdds.odds * 1.02; // 2% commission
      const profitPercent = ((bestBack.odds - effectiveLay) / effectiveLay) * 100;
      if (!bestArb || profitPercent > bestArb.profitPercent) {
        bestArb = {
          backBookmaker: bestBack.bookmaker,
          layExchange: outcome.layOdds.exchange,
          outcomeName: outcome.name,
          profitPercent: Math.round(profitPercent * 100) / 100,
          isProfitable: profitPercent > 0,
        };
      }
    }
  }

  return {
    id: `match-${id}`,
    sport: isWC ? "World Cup 2026" : "Football",
    league: isWC ? "World Cup 2026" : "Premier League",
    homeTeam: home,
    awayTeam: away,
    commenceTime: commenceTime.toISOString(),
    isWorldCup: isWC,
    outcomes,
    bestArbitrage: bestArb || undefined,
  };
}

function generateWCMatches(): Match[] {
  const matches: Match[] = [];
  // 16 group stage matches
  for (let i = 0; i < 16; i++) {
    matches.push(generateMatch(i + 1, true));
  }
  // 8 knockout matches
  for (let i = 0; i < 8; i++) {
    matches.push(generateMatch(i + 100, true));
  }
  return matches;
}

function generateLeagueMatches(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 20; i++) {
    matches.push(generateMatch(i + 200, false));
  }
  return matches;
}

export async function fetchMatches(
  includeWc: boolean = true,
  includeLeague: boolean = true
): Promise<{ worldCup: Match[]; league: Match[] }> {
  // If ODDS_API_KEY is set, fetch from live API
  if (ODDS_API_KEY) {
    try {
      return await fetchFromOddsApi();
    } catch {
      // Fall back to mock data on error
    }
  }

  // Return mock data
  return {
    worldCup: includeWc ? generateWCMatches() : [],
    league: includeLeague ? generateLeagueMatches() : [],
  };
}

async function fetchFromOddsApi(): Promise<{ worldCup: Match[]; league: Match[] }> {
  // For future live integration
  const sports = ["soccer_world_cup", "soccer_epl"];
  const results: { worldCup: Match[]; league: Match[] } = {
    worldCup: [],
    league: [],
  };

  for (const sport of sports) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    // Parse into our format - placeholder for when API is live
    console.log(`Fetched ${sport} data`, data.length, "matches");
  }

  return results;
}

export function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function calculateProfit(stake: number, backOdds: number, layOdds: number, commission: number = 2): {
  layStake: number;
  profit: number;
  liability: number;
  roi: number;
} {
  const commissionFactor = 1 - commission / 100;
  const layStake = (stake * backOdds) / (layOdds - commission / 100);
  const profitIfBackWins = stake * (backOdds - 1) - layStake * (layOdds - 1);
  const profitIfLayWins = layStake * commissionFactor - stake;
  const profit = Math.max(profitIfBackWins, profitIfLayWins);
  const liability = layStake * (layOdds - 1);
  const roi = ((profit / (stake + liability)) * 100);

  return {
    layStake: Math.round(layStake * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    liability: Math.round(liability * 100) / 100,
    roi: Math.round(roi * 100) / 100,
  };
}