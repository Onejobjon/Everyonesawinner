// Post-publish smoke test. Fails loudly (exit non-zero + Telegram ping) if the
// live surfaces stop serving JSON odds — the exact silent breakage that took
// the custom domain down for days. Run after every publish.
//
//   node scripts/verify-deploy.mjs
//
// Checks BOTH the platform URL and the custom domain. A healthy /api/odds
// returns application/json with a non-empty array.
const PLATFORM_URL =
  process.env.HEALTH_PLATFORM_URL ||
  "https://515136800b641762e9aace79427eb7c4.ctonew.app/api/odds?sport=upcoming";
const DOMAIN_URL =
  process.env.HEALTH_DOMAIN_URL ||
  "https://www.everyonesawinner.uk/api/odds?sport=upcoming";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function isHealthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return { ok: false, why: `content-type ${ct}` };
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, why: `no events (${Array.isArray(data) ? data.length : "not an array"})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e) };
  }
}

async function pingTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
  } catch {
    /* ping is best-effort */
  }
}

const results = await Promise.all([
  isHealthy(PLATFORM_URL).then((r) => ({ label: "platform", url: PLATFORM_URL, ...r })),
  isHealthy(DOMAIN_URL).then((r) => ({ label: "domain", url: DOMAIN_URL, ...r })),
]);

let failed = false;
for (const r of results) {
  if (r.ok) {
    console.log(`✓ ${r.label} odds healthy (${r.url})`);
  } else {
    failed = true;
    console.error(`✗ ${r.label} odds BROKEN: ${r.why} (${r.url})`);
  }
}

if (failed) {
  const lines = results
    .filter((r) => !r.ok)
    .map((r) => `• ${r.label}: ${r.why}`);
  await pingTelegram(`⚠️ Post-publish smoke test failed:\n${lines.join("\n")}`);
  process.exit(1);
}
console.log("✓ all live surfaces serving odds");
