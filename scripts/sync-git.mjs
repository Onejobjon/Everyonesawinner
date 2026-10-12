// Syncs the committed site code to GitHub after a successful build.
// Runs inside the platform publish/build environment where owner secrets
// (GITHUB_TOKEN) are injected as env vars. Never fails the build — a
// failed sync is logged, not thrown, so site publishing stays independent.
// The token is scrubbed from every log line and never written to disk.
import { execSync } from "node:child_process";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = "Onejobjon/Everyonesawinner";
const scrub = (s) => (TOKEN ? String(s).split(TOKEN).join("***") : String(s));

function sh(cmd) {
  return execSync(cmd, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  if (!TOKEN) {
    console.log("[git-sync] GITHUB_TOKEN not set — skipping git sync (site-only publish)");
    process.exit(0);
  }

  const head = sh("git rev-parse HEAD");
  const url = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;

  let remoteSha = null;
  try {
    const out = sh(`git ls-remote ${url} refs/heads/main`);
    remoteSha = out ? out.split(/\s+/)[0] : null;
  } catch (e) {
    console.log(`[git-sync] could not read remote (continuing to push attempt): ${scrub(e.message).slice(0, 160)}`);
  }

  if (remoteSha === head) {
    console.log(`[git-sync] already up to date (${head.slice(0, 7)})`);
    process.exit(0);
  }

  try {
    sh(`git push ${url} HEAD:refs/heads/main`);
    console.log(`[git-sync] pushed ${head.slice(0, 7)} to ${REPO} main`);
  } catch (e) {
    console.log(`[git-sync] push failed: ${scrub(e.message).slice(0, 300)}`);
  }
} catch (e) {
  console.log(`[git-sync] unexpected error: ${scrub(e.message).slice(0, 300)}`);
}
process.exit(0);
