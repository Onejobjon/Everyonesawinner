// Server-only database operations - never imported on client side
// Use dynamic import in createServerFn handlers

export type { JwtPayload } from "./auth-types";
export { getDb, getDashboard, seedDashboard, updateDashboardProfit, incrementCompletedOffers, addActiveOffer } from "./db-server";