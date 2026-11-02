/**
 * The owner's alarm bell for things that cost money or strand a customer.
 *
 * WHAT IT IS FOR (2026-11-02): billing code has failure modes nobody sees —
 * a Stripe price id that does not match the configured ones, a checkout that
 * lands on an address with no account, a write to the account store that fails.
 * Before this, each of those ended in a `console.log` that said "ok". Now they
 * reach the owner in the same Telegram chat the alert worker already uses.
 *
 * DELIBERATELY SEPARATE from src/server/alerts.ts: that module owns the odds
 * scanner (1200 lines, a scan loop, its own files). The webhook must not import
 * the scanner to send one sentence, and must never fail because Telegram is
 * down — notifyOwner() never throws, and it still logs to the process log when
 * no channel is configured.
 *
 * Customer email is NOT sent from here. This is the owner's channel only.
 */

const MAX_RECENT = 50;
const recent: Array<{ at: string; text: string }> = [];

/** The last owner alerts this process raised (tests, diagnostics). */
export function recentOwnerAlerts(): Array<{ at: string; text: string }> {
  return [...recent];
}

function remember(text: string): void {
  recent.push({ at: new Date().toISOString(), text });
  if (recent.length > MAX_RECENT) recent.shift();
}

/**
 * Send the owner one plain sentence. Never throws, never blocks the caller's
 * outcome: a billing write that succeeded stays succeeded even if Telegram is
 * unreachable (the log still carries the message).
 */
export async function notifyOwner(text: string): Promise<boolean> {
  remember(text);
  console.error(`[owner-alert] ${text}`);

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    console.warn("[owner-alert] no Telegram channel configured — logged only");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `⚠️ Everyone's A Winner — ${text}` }),
    });
    if (!res.ok) {
      console.error(`[owner-alert] Telegram returned ${res.status} — logged only`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[owner-alert] Telegram unreachable: ${String(e)} — logged only`);
    return false;
  }
}
