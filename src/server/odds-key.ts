/**
 * Server-only Odds API key.
 *
 * The key is read from the ODDS_API_KEY owner secret when present, with a
 * fallback so the preview/dev environment keeps working before a secret is
 * set. This module is imported ONLY by server code (serve-static.ts and the
 * alert worker) — it must never be imported from client code, so the literal
 * key never ships in the public JS bundle.
 */
export const ODDS_API_KEY =
  process.env.ODDS_API_KEY || "5827ab1071dd26e737d7d2d1054ef8b4";
