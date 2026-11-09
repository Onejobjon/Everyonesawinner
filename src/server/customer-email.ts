/**
 * THE CUSTOMER-FACING EMAILS, COMPOSED AND RECORDED.
 *
 * Two messages, both promised by /terms and neither sent before 2026-11-09:
 *
 *   • RECEIPT (terms §7) — after a payment: the plan, the amount, the date, who
 *     was paid (Jonathan Revill, sole trader, trading as Everyone's A Winner,
 *     not VAT registered), and how to cancel at /account.
 *   • GRACE NOTICE (terms §9) — after a card fails: the date the grace period
 *     ends, that access continues until then, how to update the card, and that
 *     cancelling during grace stops any further payment.
 *
 * WHY THE COPY LIVES HERE, not in the webhook: the webhook's job is billing
 * state, and a receipt is a document a customer keeps. Keeping the words in one
 * file means the seller identity cannot drift between the site and the email —
 * the identity block below is the same sentence /terms §1 publishes.
 *
 * THE RULE ABOUT PROMISES: every line is either a fact from the event or a
 * promise /terms already makes. No countdowns, no "action required", no
 * deadline that is not the real grace date.
 *
 * NOTHING HERE THROWS. `deliverCustomerEmail` composes, sends, records and
 * reports; a mail provider being down must never fail a Stripe event.
 */
import { PUBLISHED_PLANS, formatPence } from "./price-catalogue";
import type { Plan } from "./entitlement";
import { notifyOwner } from "./notify-owner";
import { store } from "./storage";
import { sendEmail } from "./email-transport";

/** The public site. Links in an email must be absolute. */
export const SITE_ORIGIN = "https://www.everyonesawinner.uk";

/** Where the customer cancels, resumes, and sees their plan. */
export const ACCOUNT_URL = `${SITE_ORIGIN}/account`;

/** The support address printed across the site. */
export const SUPPORT_EMAIL = "support@everyonesawinner.uk";

/**
 * The seller identity, word for word as /terms §1 and /subscribe publish it.
 * A receipt has to say who took the money, and "Everyone's A Winner" alone is
 * not a legal identity.
 */
export const SELLER_IDENTITY =
  "Everyone's A Winner is the trading name of Jonathan Revill, a sole trader, of 3 Clanmaghery " +
  "Grove, Ballykinler, Downpatrick, BT30 8EX, in the United Kingdom. We are not a registered " +
  "company, so there is no company number, and we are not registered for VAT, so no VAT is " +
  "added to any price.";

export type CustomerEmailKind = "receipt" | "grace";

/** A composed message, ready for the transport. */
export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Facts a receipt is built from. Anything unknown stays unknown, never guessed. */
export interface ReceiptFacts {
  /** The account's email (the address the customer signed up with). */
  to: string;
  /** The plan we matched the price to, or null when we could not name it. */
  plan: Plan | null;
  /** What Stripe says was paid, in minor units; null when the event carried none. */
  amountPence: number | null;
  /** ISO 4217 code from the event ("gbp"). */
  currency: string;
  /** ISO timestamp of the payment. */
  paidAt: string;
  /** End of the period this payment bought, when the event carries it. */
  periodEnd: string | null;
  /** The provider's invoice id, quoted so support can find the payment. */
  invoiceId: string | null;
}

/** Facts a grace notice is built from. */
export interface GraceFacts {
  to: string;
  plan: Plan | null;
  /** ISO timestamp: the day access stops if the card is not fixed. */
  graceEndsAt: string;
}

// ── Small formatters ────────────────────────────────────────────────────────

/**
 * "9 November 2026", in London time (the business is in the UK and the terms
 * quote UK dates). Falls back to the plain ISO date if Intl is unavailable.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return "";
  try {
    return when.toLocaleDateString("en-GB", {
      timeZone: "Europe/London",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

/** "Starter — £19.99 a month", or "" when the plan could not be named. */
export function planLine(plan: Plan | null): string {
  if (!plan) return "";
  const p = PUBLISHED_PLANS[plan];
  if (!p) return "";
  return `${p.label} — ${formatPence(p.amountPence)} a ${p.interval}`;
}

/** A paid amount, from minor units. Non-GBP is labelled with its currency. */
export function formatAmount(amountPence: number | null, currency: string): string {
  if (amountPence === null) return "";
  const code = (currency || "gbp").toLowerCase();
  if (code === "gbp") return formatPence(amountPence);
  return `${(amountPence / 100).toFixed(2)} ${code.toUpperCase()}`;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Plain text → the simplest HTML that survives a mail client.
 *
 * Blank lines separate paragraphs and single newlines break lines. Nothing
 * else: no images, no tracking pixel, no "view in browser" link. An email that
 * cannot be misread is worth more than one that looks designed.
 */
export function textToHtml(text: string): string {
  const paragraphs = text.trim().split(/\n{2,}/);
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px 0">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;` +
    `line-height:1.55;color:#111827;max-width:600px">${body}</div>`
  );
}

// ── The receipt ─────────────────────────────────────────────────────────────

/**
 * The receipt for a completed payment — the first payment and every renewal.
 *
 * A receipt is a record, so it states the amount from the event rather than the
 * price list: a discount, a proration or a currency change would make the
 * catalogue figure a lie. When the event carries no amount, the line says so.
 */
export function composeReceipt(facts: ReceiptFacts): ComposedEmail {
  const plan = planLine(facts.plan);
  const amount = formatAmount(facts.amountPence, facts.currency);
  const paidOn = formatDate(facts.paidAt);
  const covers = formatDate(facts.periodEnd);

  const lines: string[] = [
    "Hello,",
    "Thank you for subscribing to Everyone's A Winner. This is your receipt.",
    [
      plan ? `Plan: ${plan}` : "Plan: (we could not match this payment to one of our published plans)",
      amount ? `Amount paid: ${amount}` : "Amount paid: (the payment record we received carried no amount)",
      paidOn ? `Paid on: ${paidOn}` : "",
      covers ? `Covers the period ending: ${covers}` : "",
      facts.invoiceId ? `Invoice: ${facts.invoiceId}` : "",
      `Paid to: Everyone's A Winner (Jonathan Revill, sole trader)`,
    ]
      .filter(Boolean)
      .join("\n"),
    "Your plan renews automatically until you cancel. You can cancel at any time at " +
      `${ACCOUNT_URL} — cancelling stops future payments and your access continues to the end of ` +
      "the period you have already paid for.",
    "If anything on this receipt is wrong, or you have a question about the payment, reply to this " +
      `email or write to ${SUPPORT_EMAIL}.`,
    SELLER_IDENTITY,
  ];

  const text = lines.join("\n\n");
  return {
    subject: amount
      ? `Your Everyone's A Winner receipt — ${amount}`
      : "Your Everyone's A Winner receipt",
    text,
    html: textToHtml(text),
  };
}

// ── The grace notice ────────────────────────────────────────────────────────

/**
 * The notice after a card fails (terms §9).
 *
 * It quotes the REAL grace end date stored on the account, says plainly that
 * nothing has been cancelled and access continues, and gives the two routes the
 * terms promise: email support for a secure card-update link, or cancel at
 * /account. It does not pretend the card will definitely work next time.
 */
export function composeGraceNotice(facts: GraceFacts): ComposedEmail {
  const plan = planLine(facts.plan);
  const ends = formatDate(facts.graceEndsAt) || facts.graceEndsAt;

  const lines: string[] = [
    "Hello,",
    "We tried to take this month's payment for your Everyone's A Winner subscription and your bank " +
      "did not authorise it. That happens for ordinary reasons — a card that has expired, a card " +
      "that has been replaced, or a bank blocking a payment it did not expect.",
    [
      plan ? `Plan: ${plan}` : "",
      `Your access continues until: ${ends}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "Nothing has been cancelled and nothing has been switched off. We will try the card again, and " +
      `your plan stays open until ${ends}.`,
    "To update your card, email " +
      `${SUPPORT_EMAIL} and we will send you a secure link to do it. You can also cancel during this ` +
      `period at ${ACCOUNT_URL} — cancelling stops any further payment being taken.`,
    `If the payment has still not gone through by ${ends}, the subscription ends and the paid tools ` +
      "lock until it is settled. Nothing further is taken from the card in the meantime.",
    SELLER_IDENTITY,
  ];

  const text = lines.join("\n\n");
  return {
    subject: "We could not take your card payment",
    text,
    html: textToHtml(text),
  };
}

// ── Delivering and recording it ─────────────────────────────────────────────

/** One line in the customer-email log. This is how we see what was sent. */
export interface CustomerEmailRecord {
  /** Sortable id, also the store key: `<ISO>|<kind>|<to>`. */
  id: string;
  at: string;
  kind: CustomerEmailKind;
  to: string;
  subject: string;
  /** sent = the provider accepted it; failed = it refused or was unreachable;
   *  unsent = no transport configured, so nothing was attempted. */
  status: "sent" | "failed" | "unsent";
  reason: string;
  provider: string | null;
  messageId?: string | null;
  /** The Stripe event this email came from, for tracing. */
  eventId?: string | null;
}

/** Where the log lives on the file driver. `CUSTOMER_EMAILS_FILE` overrides. */
const emailStore = () => store<CustomerEmailRecord>("customer-emails");

/** A key that sorts by time and stays unique when two land in the same ms. */
function recordKey(kind: CustomerEmailKind, to: string, at: string): string {
  const jitter = Math.random().toString(36).slice(2, 8);
  return `${at}|${kind}|${to}|${jitter}`;
}

/**
 * Send one customer email and record what happened. NEVER THROWS.
 *
 * The three outcomes are all normal:
 *   • sent   — the provider accepted it; logged and recorded.
 *   • failed — the provider refused or was unreachable; logged, recorded, and
 *              the OWNER is alerted, because a paying customer just got nothing.
 *   • unsent — no transport configured; logged and recorded, and deliberately
 *              NOT alerted, because that is today's known state (billing is on
 *              hold) and an alert per payment would be noise.
 */
export async function deliverCustomerEmail(
  kind: CustomerEmailKind,
  message: ComposedEmail,
  input: { to: string; eventId?: string | null },
): Promise<CustomerEmailRecord> {
  const at = new Date().toISOString();
  const to = String(input.to || "").trim();

  let outcome;
  try {
    outcome = await sendEmail({ to, subject: message.subject, text: message.text, html: message.html });
  } catch (e) {
    // sendEmail does not throw, but a caller must never depend on that.
    outcome = {
      sent: false,
      code: "provider_error" as const,
      provider: null,
      reason: `transport error: ${String(e)}`,
      messageId: null,
    };
  }

  const record: CustomerEmailRecord = {
    id: recordKey(kind, to, at),
    at,
    kind,
    to,
    subject: message.subject,
    status: outcome.sent ? "sent" : outcome.code === "not_configured" ? "unsent" : "failed",
    reason: outcome.reason,
    provider: outcome.provider ?? null,
    messageId: outcome.messageId ?? null,
    eventId: input.eventId ?? null,
  };

  // Record it. A log that cannot be written must not undo a sent email.
  try {
    await emailStore().put(record.id, record);
  } catch (e) {
    console.warn(`[customer-email] could not record the ${kind} for ${to}: ${String(e)}`);
  }

  if (record.status === "sent") {
    console.log(`[customer-email] ${kind} sent to ${to} via ${record.provider} (${record.messageId ?? "no id"})`);
  } else if (record.status === "failed") {
    console.error(`[customer-email] ${kind} to ${to} FAILED: ${record.reason}`);
    await notifyOwner(
      `Customer email FAILED — the ${kind === "receipt" ? "receipt" : "failed-card notice"} for ${to} ` +
        `was not sent (${record.reason}). ${kind === "receipt" ? "A paying customer has no receipt" : "A customer whose card failed has not been told"}; ` +
        `send it by hand from ${SUPPORT_EMAIL}.`,
    );
  } else {
    console.warn(`[customer-email] ${kind} for ${to} not sent — ${record.reason}`);
  }

  return record;
}

/**
 * The most recent customer emails, newest last. For the owner's diagnostics —
 * "did that receipt actually go out?" answered from our own records rather than
 * from the provider's dashboard.
 */
export async function recentCustomerEmails(limit = 20): Promise<CustomerEmailRecord[]> {
  try {
    const rows = await emailStore().list();
    const sorted = rows
      .map((row) => row.value)
      .sort((a, b) => String(a?.at ?? "").localeCompare(String(b?.at ?? "")));
    return limit > 0 ? sorted.slice(-limit) : sorted;
  } catch (e) {
    console.warn(`[customer-email] could not read the email log: ${String(e)}`);
    return [];
  }
}
