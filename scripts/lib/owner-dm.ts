/**
 * The one way a script under scripts/ talks to the owner's PRIVATE DM.
 *
 * WHY THIS EXISTS: three runners now speak to the owner about the machinery
 * (scripts/alert-gap-alarm.ts, scripts/alert-restart-report.ts,
 * scripts/alert-heartbeat.ts). Each of them must obey the same rule, and the
 * rule lives in src/server/telegram-channels.ts:
 *
 *   a SYSTEM message goes to TELEGRAM_ADMIN_CHAT_ID only, must be a PRIVATE
 *   chat (a positive id), and is SUPPRESSED — never redirected to the
 *   customer-facing alerts group — when no private admin chat is configured.
 *
 * Duplicating that resolution three times is how the split gets undone by a
 * future edit, so it is imported here and nowhere else in scripts/.
 *
 * Credentials are read from the 0600 secrets file at start-up and never printed.
 * A missing file is not fatal: the message is logged and suppressed.
 */
import { existsSync, readFileSync } from "node:fs";
import { maySend, resolveChatId, systemSuppressionReason } from "../../src/server/telegram-channels";

const SECRETS_FILE = process.env.EAW_SECRETS_FILE || "/home/team/shared/.secrets/telegram.env";

/** Load TELEGRAM_* / ODDS_API_KEY from the owner's 0600 file into process.env. */
export function loadSecrets(file: string = SECRETS_FILE): void {
  if (!existsSync(file)) return;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, "").trim();
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* an unreadable secrets file is not fatal — we simply cannot send */
  }
}

/**
 * Send one system message to the owner's private DM. Never throws, and returns
 * false (having logged why) when the message could not be delivered — callers
 * use that to decide whether to record the send.
 */
export async function sendSystemMessage(text: string, tag: string): Promise<boolean> {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = resolveChatId("system");
  if (!chatId) {
    console.error(`[${tag}] suppressed — ${systemSuppressionReason()}; message NOT sent`);
    return false;
  }
  // Belt and braces: the send site refuses a group id even if it was asked for.
  if (!maySend("system", chatId)) {
    console.error(`[${tag}] suppressed — ${chatId} is not a private chat; message NOT sent`);
    return false;
  }
  if (!token) {
    console.error(`[${tag}] no Telegram credentials — message NOT sent`);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;
    if (res.ok && body?.ok) {
      console.log(`[${tag}] telegram ok msg_id=${body.result?.message_id ?? "?"}`);
      return true;
    }
    console.error(`[${tag}] telegram failed: ${body?.description || `HTTP ${res.status}`}`);
    return false;
  } catch (e) {
    console.error(`[${tag}] telegram error: ${String(e)}`);
    return false;
  }
}
