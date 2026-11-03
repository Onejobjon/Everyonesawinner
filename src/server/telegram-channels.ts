/**
 * TWO TELEGRAM DESTINATIONS, AND THE RULE THAT KEEPS THEM APART.
 *
 * OWNER DEFECT (2026-11-03): every message the bot sent — opportunity alerts AND
 * the machinery talking about itself — went to whichever single id was in
 * TELEGRAM_CHAT_ID. That is how a customer-facing group ends up reading
 * "scan stalled for 75 minutes" and how the owner's DM ends up as the alerts
 * channel by accident. The two audiences are now separate:
 *
 *   ALERTS  — opportunity alerts. Customer-facing. TELEGRAM_ALERTS_CHAT_ID, and
 *             it MAY be a group (that is the point of it).
 *   ADMIN   — everything the SYSTEM says: stall/gap alarms, delivery self-tests,
 *             heartbeats, billing/owner notifications. TELEGRAM_ADMIN_CHAT_ID
 *             ONLY, and it must be a PRIVATE chat.
 *
 * HARD RULE — a system message is NEVER sent to a chat id beginning with "-"
 * (a group or supergroup), and it is never redirected to the alerts channel
 * either. If no private admin chat is configured the message is SUPPRESSED and
 * logged: our internals stay in our own log rather than in front of customers.
 *
 * TELEGRAM_CHAT_ID is still read, but only as the ALERTS fallback, so a machine
 * replacement that restores the old single variable does not go silent.
 *
 * Pure functions over an env map, so the rule can be proven without a network
 * call or a real bot — see test/telegram-channels.test.ts.
 */

export type TelegramChannel = "alerts" | "system";

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

/** A group/supergroup chat id in Telegram is negative: `-5018337058`. */
export function isGroupChatId(id: string | null | undefined): boolean {
  return /^-\d+$/.test((id ?? "").trim());
}

/**
 * A private chat id is a positive integer. Everything else — a group (negative),
 * a `@channel` username, an empty string — is not a private admin chat.
 */
export function isPrivateChatId(id: string | null | undefined): boolean {
  return /^\d+$/.test((id ?? "").trim());
}

/**
 * Where opportunity alerts go. May be a group. Falls back to the legacy
 * TELEGRAM_CHAT_ID so an old machine keeps alerting after a replacement.
 */
export function alertsChatId(env: Env = process.env): string {
  return read(env, "TELEGRAM_ALERTS_CHAT_ID") || read(env, "TELEGRAM_CHAT_ID");
}

/**
 * Where system messages go: the private admin chat, or null to suppress.
 * Deliberately does NOT fall back to TELEGRAM_CHAT_ID or the alerts channel —
 * those may be a customer group.
 */
export function adminChatId(env: Env = process.env): string | null {
  const admin = read(env, "TELEGRAM_ADMIN_CHAT_ID");
  return isPrivateChatId(admin) ? admin : null;
}

/** The chat id a message of this kind may go to, or null when it must be suppressed. */
export function resolveChatId(channel: TelegramChannel, env: Env = process.env): string | null {
  // Anything that is not explicitly a system message is treated as an alert.
  // A typo must fail towards "customer alert to the alerts chat", never towards
  // "internal chatter in the owner's DM" — and never the reverse.
  return channel === "system" ? adminChatId(env) : alertsChatId(env) || null;
}

/**
 * Why a system message was suppressed, in words that can go straight into the
 * log. Only called when resolveChatId("system") returned null.
 */
export function systemSuppressionReason(env: Env = process.env): string {
  const raw = read(env, "TELEGRAM_ADMIN_CHAT_ID");
  if (!raw) return "TELEGRAM_ADMIN_CHAT_ID is not set";
  if (isGroupChatId(raw)) {
    return `TELEGRAM_ADMIN_CHAT_ID (${raw}) is a GROUP id — system messages never go to a group`;
  }
  return `TELEGRAM_ADMIN_CHAT_ID (${raw}) is not a private chat id`;
}

/**
 * The last line of defence, used by every send site: a system message addressed
 * to a group is refused even if the caller asked for it explicitly.
 */
export function maySend(channel: TelegramChannel, chatId: string | null, env: Env = process.env): boolean {
  if (!chatId) return false;
  if (channel === "system") return isPrivateChatId(chatId) && !isGroupChatId(chatId);
  return true;
}
