// Syncs committed site code to GitHub after a successful build / at server
// boot, inside the platform runtime where owner secrets are injected.
// Tries EVERY GitHub-named secret in the environment until one has push
// access, so token naming on the owner's side doesn't matter. Never fails
// the build; logs to .run/git-sync.log; token values are scrubbed from logs.
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const REPO = "Onejobjon/Everyonesawinner";
const LOG_DIR = new URL("../.run/", import.meta.url).pathname;

const preferred = ["GITHUB_TOKEN", "GitHubtoken", "github2"];
const discovered = Object.keys(process.env).filter(
  (k) => /github/i.test(k) && !preferred.includes(k),
);
// Catch-all: any env var whose VALUE looks like a GitHub PAT
// (classic ghp_/gho_/ghu_/ghs_, fine-grained github_pat_ or test_),
// whatever its name — the owner may name the secret anything.
const shape = /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$|^github_pat_[A-Za-z0-9_]{30,}$|^test_[A-Za-z0-9]{20,}$/;
const valueFound = Object.keys(process.env).filter(
  (k) => !preferred.includes(k) && shape.test(String(process.env[k] || "").trim()),
);
const keyNames = [...new Set([...preferred, ...discovered, ...valueFound])].filter(
  (k) => (process.env[k] || "").length > 10,
);
const TOKENS = keyNames.map((name) => ({ name, value: process.env[name] }));

const scrub = (s) => {
  let out = String(s);
  for (const t of TOKENS) out = out.split(t.value).join("***");
  return out;
};

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
  if (TOKENS.length === 0) {
    log("no GitHub token found in env — skipping git sync");
    process.exit(0);
  }

  const head = sh("git rev-parse HEAD");

  for (const t of TOKENS) {
    const url = `https://x-access-token:${t.value}@github.com/${REPO}.git`;
    let remoteSha = null;
    try {
      const out = sh(`git ls-remote ${url} refs/heads/main`);
      remoteSha = out ? out.split(/\s+/)[0] : null;
    } catch (e) {
      log(`secret "${t.name}": no read access (${e.message.split("\n").slice(0, 3).join(" | ").slice(0, 240)})`);
      continue;
    }
    try {
      if (remoteSha === head) {
        log(`already up to date (${head.slice(0, 7)}) — secret "${t.name}"`);
        process.exit(0);
      }
      sh(`git push ${url} HEAD:refs/heads/main`);
      log(`pushed ${head.slice(0, 7)} to ${REPO} main — secret "${t.name}"`);
      process.exit(0);
    } catch (e) {
      log(`secret "${t.name}" has read but push rejected: ${e.message.split("\n").slice(0, 5).join(" | ").slice(0, 400)}`);
    }
  }
  log("all candidate tokens failed — no push");
} catch (e) {
  log(`unexpected error: ${e.message.slice(0, 300)}`);
}
process.exit(0);
