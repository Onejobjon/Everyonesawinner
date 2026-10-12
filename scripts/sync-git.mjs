// Syncs the committed site code to GitHub after a successful build.
// Runs inside the platform publish/build environment where owner secrets
// (GITHUB_TOKEN) are injected as env vars. Never fails the build — a
// failed sync is logged, not thrown, so site publishing stays independent.
// The token is scrubbed from every log line and never written to disk.
import { execSync, exec } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

// Accept both spellings — the owner's saved secret is "GitHubtoken".
const TOKEN = process.env.GITHUB_TOKEN || process.env.GitHubtoken;
const REPO = "Onejobjon/Everyonesawinner";
const LOG_DIR = new URL("../.run/", import.meta.url).pathname;
const scrub = (s) => (TOKEN ? String(s).split(TOKEN).join("***") : String(s));

function log(msg) {
  const line = `[git-sync ${new Date().toISOString()}] ${scrub(msg)}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}git-sync.log`, line + "\n");
  } catch { /* logging must never break the sync */ }
}

function sh(cmd) {
  return execSync(cmd, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  if (!TOKEN) {
    log("GITHUB_TOKEN not set — skipping git sync (site-only publish)");
    process.exit(0);
  }

  const head = sh("git rev-parse HEAD");
  const url = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;

  let remoteSha = null;
  try {
    const out = sh(`git ls-remote ${url} refs/heads/main`);
    remoteSha = out ? out.split(/\s+/)[0] : null;
  } catch (e) {
    log(`could not read remote (continuing to push attempt): ${e.message.slice(0, 160)}`);
  }

  if (remoteSha === head) {
    log(`already up to date (${head.slice(0, 7)})`);
    process.exit(0);
  }

  try {
    sh(`git push ${url} HEAD:refs/heads/main`);
    log(`pushed ${head.slice(0, 7)} to ${REPO} main`);
  } catch (e) {
    log(`push failed: ${e.message.slice(0, 300)}`);
  }
} catch (e) {
  log(`unexpected error: ${e.message.slice(0, 300)}`);
}
process.exit(0);
