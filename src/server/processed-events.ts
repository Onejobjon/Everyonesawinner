/**
 * IDEMPOTENCY FOR STRIPE EVENTS — the processed-event ledger.
 *
 * WHY (2026-11-03): Stripe delivers at-least-once. It retries a slow endpoint, it
 * retries a 500, and an operator can replay an event by hand from the dashboard.
 * Without a ledger, a replayed `customer.subscription.created` from three months
 * ago would resurrect a subscription the customer has since cancelled, and a
 * replayed `invoice.payment_failed` would re-open a closed grace window. Neither
 * is a state we can see from the event itself: the payload is identical.
 *
 * THE SHAPE OF THE FIX: an event is processed at most once, keyed by its Stripe
 * event id (`evt_...`). The id is RESERVED before the handler runs, so two
 * deliveries arriving at the same moment cannot both apply; if the handler throws
 * the reservation is RELEASED, so Stripe's retry gets a clean attempt.
 *
 * WHERE IT LIVES: a JSON file next to the account store (same disk, same
 * durability, same caveat as accounts today). `STRIPE_EVENTS_FILE` overrides the
 * path — tests point it at a temp dir. The last MAX_EVENTS ids are kept; older
 * ones fall off, which is safe because Stripe stops retrying after ~3 days.
 *
 * FAILURE POLICY: if the ledger cannot be written we do NOT drop the event — the
 * customer must not be stranded because a file is read-only. We process it, alert
 * the owner and say so in the note. Every handler writes absolute state (status,
 * period end, and a grace date that is deliberately kept the first time it is
 * set), so applying one twice is safe; the ledger is the belt, not the braces.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { usersFile } from "./users";
import { notifyOwner } from "./notify-owner";

/** How many event ids to remember. Stripe gives up retrying after about 3 days. */
const MAX_EVENTS = 2000;

/** The note written on reservation, replaced once the handler returns. */
const IN_FLIGHT = "in flight";

/** A reservation older than this is treated as abandoned (a process died). */
const IN_FLIGHT_STALE_MS = 5 * 60 * 1000;

interface LoggedEvent {
  /** The Stripe event id (evt_...). */
  id: string;
  /** When we first saw it (ISO 8601). */
  at: string;
  /** What the handler did with it, for the owner's diagnostics. */
  note: string;
}

interface EventLog {
  events: LoggedEvent[];
}

/** Where the ledger lives. `STRIPE_EVENTS_FILE` wins; otherwise beside accounts. */
export function eventsFile(): string {
  const explicit = (process.env.STRIPE_EVENTS_FILE || "").trim();
  if (explicit) return explicit;
  return join(dirname(usersFile()), "stripe-events.json");
}

function load(): EventLog {
  const file = eventsFile();
  if (!existsSync(file)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as EventLog;
    return Array.isArray(parsed?.events) ? { events: parsed.events } : { events: [] };
  } catch {
    // A corrupt ledger must not stop billing. An empty ledger re-processes an
    // event at worst, and every handler is safe to apply twice (see above).
    console.warn(`[stripe-events] ${file} is unreadable — starting a fresh ledger`);
    return { events: [] };
  }
}

function save(log: EventLog): void {
  const file = eventsFile();
  mkdirSync(dirname(file), { recursive: true });
  const trimmed = log.events.slice(-MAX_EVENTS);
  writeFileSync(file, JSON.stringify({ events: trimmed }, null, 2));
}

/** The ids we have already applied (tests, diagnostics). */
export function processedEventIds(): string[] {
  return load().events.filter((e) => e.note !== IN_FLIGHT).map((e) => e.id);
}

/** Has this event id already been applied to completion? */
export function wasProcessed(eventId: string | null | undefined): boolean {
  const id = (eventId || "").trim();
  if (!id) return false;
  return load().events.some((e) => e.id === id && e.note !== IN_FLIGHT);
}

export interface IdempotentRun<T> {
  /** True when this id was already applied, so `run` was NOT called. */
  skipped: boolean;
  /** What the handler returned, when it ran. */
  result: T | null;
  /** The note the first delivery stored, when skipped. */
  note: string | null;
  /** True when the ledger could not be written and we processed anyway. */
  withoutLedger: boolean;
}

/**
 * Run `run` at most once for `eventId`.
 *
 * An event with NO id cannot be deduped — it is processed and the owner is told,
 * because a Stripe event always has one and a missing id means something other
 * than Stripe sent it.
 */
export async function withEventIdempotency<T>(
  eventId: string | null | undefined,
  run: () => Promise<T>,
): Promise<IdempotentRun<T>> {
  const id = (eventId || "").trim();
  if (!id) {
    await notifyOwner(
      "A Stripe event arrived with no event id, so it could not be deduplicated. " +
        "It was applied once; if it is delivered again it will be applied again.",
    );
    return { skipped: false, result: await run(), note: null, withoutLedger: true };
  }

  let log: EventLog;
  try {
    log = load();
  } catch (e) {
    await notifyOwner(`Could not read the processed-event ledger (${String(e)}) — processing the event anyway.`);
    return { skipped: false, result: await run(), note: null, withoutLedger: true };
  }

  const existing = log.events.find((e) => e.id === id);
  if (existing) {
    // Already applied. Answer 200 (not an error): Stripe must stop retrying, and
    // re-applying would be the bug we are here to prevent.
    if (existing.note !== IN_FLIGHT) {
      return { skipped: true, result: null, note: existing.note, withoutLedger: false };
    }
    // A reservation with no result: either the same event is being handled right
    // now, or a process died mid-event. Treat a recent one as in-progress and a
    // stale one as abandoned, so a crash cannot wedge an event for ever.
    const started = Date.parse(existing.at);
    const ageMs = Number.isFinite(started) ? Date.now() - started : Infinity;
    if (ageMs < IN_FLIGHT_STALE_MS) {
      return { skipped: true, result: null, note: "already being applied", withoutLedger: false };
    }
  }

  // Reserve BEFORE running, so a concurrent delivery of the same id sees it.
  log.events = log.events.filter((e) => e.id !== id);
  log.events.push({ id, at: new Date().toISOString(), note: IN_FLIGHT });
  let ledgerWritable = true;
  try {
    save(log);
  } catch (e) {
    ledgerWritable = false;
    await notifyOwner(
      `Could not record Stripe event ${id} as processed (${String(e)}). It was applied, but a ` +
        `duplicate delivery would be applied again. Check the disk the account store is on.`,
    );
  }

  try {
    const result = await run();
    if (ledgerWritable) {
      const after = load();
      const row = after.events.find((e) => e.id === id);
      if (row) {
        row.note = typeof result === "string" ? result : "applied";
      }
      try {
        save(after);
      } catch (e) {
        console.warn(`[stripe-events] could not update the note for ${id}: ${String(e)}`);
      }
    }
    return { skipped: false, result, note: null, withoutLedger: !ledgerWritable };
  } catch (e) {
    // The handler failed: release the reservation so Stripe's retry can work.
    if (ledgerWritable) {
      try {
        const after = load();
        after.events = after.events.filter((row) => row.id !== id);
        save(after);
      } catch (inner) {
        console.warn(`[stripe-events] could not release ${id}: ${String(inner)}`);
      }
    }
    throw e;
  }
}
