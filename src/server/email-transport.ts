/**
 * THE ONE PLACE AN EMAIL ACTUALLY LEAVES THE BUILDING.
 *
 * WHY THIS FILE EXISTS (2026-11-09): the Stripe webhook already decided when a
 * customer email was due — a receipt after a payment, a grace notice after a
 * failed card — and then wrote "EMAIL DUE" into the owner's Telegram and stopped.
 * Billing is armed, so the first real £19.99 would have taken money from someone
 * who then received nothing: no receipt, and (worse) no notice that their card
 * had failed. This module is the transport that was missing.
 *
 * ── THE CONTRACT (both halves are load-bearing) ──────────────────────────────
 *   1. NO KEY CONFIGURED ⇒ nothing is sent, nothing throws. A missing key must
 *      never cost a customer their payment, so this function is a no-op that
 *      reports "not configured" and the caller records the email as unsent.
 *   2. KEY CONFIGURED ⇒ the message goes out and the OUTCOME (sent / failed +
 *      reason) comes back as a value. It is never an exception: a mail provider
 *      being down is not a reason to answer Stripe with a 500 and have the whole
 *      event replayed.
 *
 * ── WHICH TRANSPORT ──────────────────────────────────────────────────────────
 * ONE environment variable picks it: `EAW_EMAIL_TRANSPORT` = `resend` (default
 * recommendation) or `postmark`. If it is unset, a configured API key implies
 * `resend`, because adding one secret should be enough to make mail work.
 * `none` turns sending off explicitly without deleting the key.
 *
 *   EAW_EMAIL_TRANSPORT   resend | postmark | none
 *   EAW_EMAIL_API_KEY     the provider's API key (RESEND_API_KEY /
 *                         POSTMARK_SERVER_TOKEN are also accepted)
 *   EAW_EMAIL_FROM        optional From header; defaults to the address below
 *
 * There is no SDK dependency: both providers are one HTTPS POST, and a mail
 * library would be another thing that can break a webhook.
 */

/** A message as the rest of the app composes it. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailProvider = "resend" | "postmark";

/**
 * What happened, in a form the caller can branch on without parsing prose.
 *
 *   sent            the provider accepted the message
 *   not_configured  no transport / no key — nothing was attempted (today's state)
 *   invalid         we refused to send it ourselves (no recipient, no body)
 *   provider_error  the provider answered with an error, or was unreachable
 */
export type SendCode = "sent" | "not_configured" | "invalid" | "provider_error";

/** What happened. `sent: false` is a normal answer, never an error to throw. */
export interface SendOutcome {
  sent: boolean;
  /** Why, as a value rather than a sentence. */
  code: SendCode;
  /** The provider used, or null when nothing was configured. */
  provider: EmailProvider | null;
  /** Human-readable why: "sent", or the reason it was not. Always set. */
  reason: string;
  /** The provider's id for the message, when it gave one. */
  messageId?: string | null;
}

/** The variable that chooses the transport. */
export const EMAIL_TRANSPORT_ENV = "EAW_EMAIL_TRANSPORT";
/** The variable carrying the API key. */
export const EMAIL_KEY_ENV = "EAW_EMAIL_API_KEY";
/** Optional override for the From header. */
export const EMAIL_FROM_ENV = "EAW_EMAIL_FROM";

/**
 * Where mail is sent from. `support@` is the address printed on /terms,
 * /subscribe and the account page, so a reply reaches the owner.
 * The domain must be verified with the provider first (DNS records) or the
 * provider refuses the message — see the note on `emailTransportStatus`.
 */
export const DEFAULT_FROM = "Everyone's A Winner <support@everyonesawinner.uk>";
export const DEFAULT_REPLY_TO = "support@everyonesawinner.uk";

/** How long to wait for the provider before giving up. A webhook cannot hang. */
const SEND_TIMEOUT_MS = 8000;

/** Read the transport choice. Unset ⇒ "resend" when a key exists, else none. */
function chosenProvider(key: string): EmailProvider | null {
  const raw = (process.env[EMAIL_TRANSPORT_ENV] || "").trim().toLowerCase();
  if (raw === "none" || raw === "off" || raw === "disabled") return null;
  if (raw === "resend" || raw === "postmark") return raw;
  // Unset (or unrecognised): a key on its own means Resend.
  return key ? "resend" : null;
}

/** The API key for the chosen provider, from our name or the provider's own. */
function apiKeyFor(provider: EmailProvider): string {
  const own = (process.env[EMAIL_KEY_ENV] || "").trim();
  if (own) return own;
  const native =
    provider === "resend"
      ? (process.env.RESEND_API_KEY || "").trim()
      : (process.env.POSTMARK_SERVER_TOKEN || "").trim();
  return native;
}

/** Everything the transport is currently configured to do — for diagnostics. */
export interface EmailTransportStatus {
  /** True only when a provider AND a key are present. */
  configured: boolean;
  provider: EmailProvider | null;
  from: string;
  /** Why it is on or off, in a sentence the owner can act on. */
  reason: string;
}

/**
 * What the transport is doing right now, without sending anything.
 *
 * Worth reading before the owner lifts the billing hold: `configured: false`
 * means a paying customer would get no receipt. The `reason` names the exact
 * secret to add, because "email is not configured" is not actionable.
 */
export function emailTransportStatus(): EmailTransportStatus {
  const ownKey = (process.env[EMAIL_KEY_ENV] || "").trim();
  const provider = chosenProvider(ownKey || (process.env.RESEND_API_KEY || "").trim() || (process.env.POSTMARK_SERVER_TOKEN || "").trim());
  const from = (process.env[EMAIL_FROM_ENV] || "").trim() || DEFAULT_FROM;
  if (!provider) {
    return {
      configured: false,
      provider: null,
      from,
      reason:
        `No email transport is configured, so customer emails are composed and recorded as unsent. ` +
        `Save ${EMAIL_TRANSPORT_ENV}=resend and ${EMAIL_KEY_ENV} (a Resend API key) to send them.`,
    };
  }
  if (!apiKeyFor(provider)) {
    return {
      configured: false,
      provider,
      from,
      reason: `${EMAIL_TRANSPORT_ENV} is "${provider}" but ${EMAIL_KEY_ENV} is empty, so nothing can be sent.`,
    };
  }
  return {
    configured: true,
    provider,
    from,
    reason: `Sending through ${provider} as ${from}.`,
  };
}

/** A plausible recipient. Deliberately loose: one @ and a dot in the domain. */
export function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Strip a provider's error body down to something a log line can hold. */
function brief(body: string, limit = 300): string {
  const text = (body || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Send one email. NEVER THROWS — every failure comes back as `sent: false`.
 *
 * The caller (customer-email.ts) records the outcome either way, so "we tried
 * and it failed" is visible instead of silent.
 */
export async function sendEmail(email: OutgoingEmail): Promise<SendOutcome> {
  try {
    if (!looksLikeEmail(email?.to)) {
      return { sent: false, code: "invalid", provider: null, reason: `not a usable email address: ${String(email?.to)}` };
    }
    const subject = (email.subject || "").trim();
    const text = (email.text || "").trim();
    if (!subject || !text) {
      return { sent: false, code: "invalid", provider: null, reason: "refusing to send an email with no subject or no body" };
    }

    const status = emailTransportStatus();
    if (!status.configured || !status.provider) {
      // THE NO-KEY PATH: this is today's behaviour, and it must stay quiet.
      return { sent: false, code: "not_configured", provider: status.provider, reason: status.reason };
    }

    const provider = status.provider;
    const key = apiKeyFor(provider);
    const to = email.to.trim();

    const res =
      provider === "resend"
        ? await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              from: status.from,
              to: [to],
              subject,
              text,
              ...(email.html ? { html: email.html } : {}),
              reply_to: DEFAULT_REPLY_TO,
            }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          })
        : await fetch("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: {
              "x-postmark-server-token": key,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              From: status.from,
              To: to,
              Subject: subject,
              TextBody: text,
              ...(email.html ? { HtmlBody: email.html } : {}),
              ReplyTo: DEFAULT_REPLY_TO,
              MessageStream: "outbound",
            }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });

    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return {
        sent: false,
        code: "provider_error",
        provider,
        reason: `${provider} refused the message (HTTP ${res.status}): ${brief(body) || "no body"}`,
      };
    }

    // Both providers answer 200 with a JSON body carrying an id. A 200 we cannot
    // parse still means accepted, so the message counts as sent.
    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const id = parsed?.id ?? parsed?.MessageID;
      messageId = typeof id === "string" ? id : null;
    } catch {
      /* accepted without a readable id — fine */
    }
    return { sent: true, code: "sent", provider, reason: `sent via ${provider}`, messageId };
  } catch (e) {
    // Includes the timeout/abort case and a DNS failure. Never propagated.
    return { sent: false, code: "provider_error", provider: null, reason: `transport error: ${String(e)}` };
  }
}
