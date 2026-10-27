/**
 * Server-only Odds API key.
 *
 * SECURITY (2026-10-27): this module used to carry a committed 32-character
 * fallback literal. The repo is PUBLIC, so that value is compromised — it was
 * removed. There is now NO key in the source tree, by design. Never put one
 * back: `scripts/scan-secrets.sh` runs before every build and fails on a
 * 32-hex literal.
 *
 * Resolution order (first hit wins):
 *   1. process.env.ODDS_API_KEY        — platform Secrets / the owner's key
 *   2. /home/team/shared/.secrets/odds.env (0600, `ODDS_API_KEY=...`)
 *   3. nothing → null. Callers must fail loudly (see oddsKeyProblem()).
 *
 * Imported ONLY by server code (serve-static.ts, the alert worker, operator
 * scripts) — never from client code, so no key can reach the public bundle.
 */
import { readFileSync } from "node:fs";

export const ODDS_SECRET_FILE =
  process.env.ODDS_ENV_FILE || "/home/team/shared/.secrets/odds.env";

function fromSecretFile(): string | null {
  try {
    const text = readFileSync(ODDS_SECRET_FILE, "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?ODDS_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const v = m[1].replace(/^["']|["']$/g, "").trim();
      if (v) return v;
    }
  } catch {
    /* absent file is not an error — it just means "no key from here" */
  }
  return null;
}

const fromEnv = (process.env.ODDS_API_KEY || "").trim();

export const ODDS_API_KEY_SOURCE: "env" | "secret-file" | "missing" = fromEnv
  ? "env"
  : fromSecretFile()
    ? "secret-file"
    : "missing";

export const ODDS_API_KEY: string | null = fromEnv || fromSecretFile() || null;

/** Human-readable explanation of a missing key, or null when one is present. */
export function oddsKeyProblem(): string | null {
  if (ODDS_API_KEY) return null;
  return (
    "ODDS_API_KEY is not configured: set it as a platform Secret (name exactly " +
    `ODDS_API_KEY) or put ODDS_API_KEY=... in ${ODDS_SECRET_FILE} (chmod 600). ` +
    "No key ships in the source tree by design."
  );
}

/** Get the key or throw with that explanation — for code paths that cannot run without it. */
export function requireOddsApiKey(): string {
  const problem = oddsKeyProblem();
  if (problem) throw new Error(problem);
  return ODDS_API_KEY as string;
}

/** Log the key state once at boot, so a missing key is never silent. */
export function logOddsKeyState(context: string): void {
  if (ODDS_API_KEY) {
    console.log(
      `[odds-key] ${context}: key present (source: ${ODDS_API_KEY_SOURCE}) — ${ODDS_API_KEY.length} chars`,
    );
  } else {
    console.error(`[odds-key] ${context}: ODDS UNAVAILABLE — ${oddsKeyProblem()}`);
  }
}
