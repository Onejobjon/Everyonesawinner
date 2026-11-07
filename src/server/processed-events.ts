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
 * WHERE IT LIVES (2026-11-07): the shared record store, src/server/storage/ —
 * `stripe-events.json` (`{ "events": [...] }`) on the file driver, the
 * `eaw_store` table when DATABASE_URL is set. The reservation is
 * `Store.create()`, which is insert-if-absent and therefore genuinely atomic:
 * on Postgres it is a PRIMARY KEY conflict, on the file driver an exclusive lock
 * around the read-modify-write. Before this, the reservation was a
 * read-modify-write of one JSON file with nothing stopping two processes
 * interleaving, so "reserved" was only true within a single process.
 *
 * The last MAX_EVENTS ids are kept; older ones fall off, which is safe because
 * Stripe stops retrying after ~3 days.
 *
 * FAILURE POLICY: if the ledger cannot be written we do NOT drop the event — the
 * customer must not be stranded because a write failed. We process it, alert the
 * owner and say so in the note. Every handler writes absolute state (status,
 * period end, and a grace date that is deliberately kept the first time it is
 * set), so applying one twice is safe; the ledger is the belt, not the braces.
 */
import { dirname, join } from "node:path";
import { cwdRunFile } from "./run-dir";
import { notifyOwner } from "./notify-owner";
import { store } from "./storage";

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

/**
 * Where the ledger lives on the FILE driver. `STRIPE_EVENTS_FILE` wins;
 * otherwise beside accounts. The path itself is owned by the storage registry
 * (src/server/storage/index.ts) — this is only for anyone inspecting the disk.
 */
export function eventsFile(): string {
  const explicit = (process.env.STRIPE_EVENTS_FILE || "").trim();
  if (explicit) return explicit;
  return join(dirname(cwdRunFile(process.env.USERS_FILE, "users.json")), "stripe-events.json");
}

const eventsStore = () => store<LoggedEvent>("stripe-events");

/** What the ledger says about an id: never seen, finished, or someone is on it. */
type Verdict = "absent" | "done" | "busy" | "stale";

function judge(row: LoggedEvent | null): Verdict {
  if (!row) return "absent";
  if (row.note !== IN_FLIGHT) return "done";
  const started = Date.parse(row.at);
  const ageMs = Number.isFinite(started) ? Date.now() - started : Infinity;
  return ageMs < IN_FLIGHT_STALE_MS ? "busy" : "stale";
}

/** Drop the oldest ids once the ledger is over its cap. Best effort. */
async function prune(): Promise<void> {
  try {
    const all = await eventsStore().list();
    if (all.length <= MAX_EVENTS) return;
    for (const entry of all.slice(0, all.length - MAX_EVENTS)) {
      await eventsStore().delete(entry.key);
    }
  } catch (e) {
    console.warn(`[stripe-events] could not prune the ledger: ${String(e)}`);
  }
}

/** The ids we have already applied (tests, diagnostics). */
export async function processedEventIds(): Promise<string[]> {
  const all = await eventsStore().list();
  return all.filter((entry) => entry.value.note !== IN_FLIGHT).map((entry) => entry.key);
}

/** Has this event id already been applied to completion? */
export async function wasProcessed(eventId: string | null | undefined): Promise<boolean> {
  const id = (eventId || "").trim();
  if (!id) return false;
  const row = await eventsStore().get(id);
  return row !== null && row.note !== IN_FLIGHT;
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

  const ledger = eventsStore();
  let existing: LoggedEvent | null;
  try {
    existing = await ledger.get(id);
  } catch (e) {
    await notifyOwner(`Could not read the processed-event ledger (${String(e)}) — processing the event anyway.`);
    return { skipped: false, result: await run(), note: null, withoutLedger: true };
  }

  const verdict = judge(existing);
  if (verdict === "done") {
    // Already applied. Answer 200 (not an error): Stripe must stop retrying, and
    // re-applying would be the bug we are here to prevent.
    return { skipped: true, result: null, note: existing!.note, withoutLedger: false };
  }
  if (verdict === "busy") {
    // Reserved moments ago: the same event is being handled right now.
    return { skipped: true, result: null, note: "already being applied", withoutLedger: false };
  }
  // "absent", or a reservation old enough to be an abandoned one (a crash must
  // not wedge an event for ever).

  // Reserve BEFORE running, so a concurrent delivery of the same id sees it.
  let ledgerWritable = true;
  const reserve = () => ({ id, at: new Date().toISOString(), note: IN_FLIGHT });
  try {
    if (verdict === "stale") {
      await ledger.put(id, reserve());
    } else if (!(await ledger.create(id, reserve()))) {
      // Another process reserved it between our read and our insert. Re-judge
      // rather than double-apply.
      const current = await ledger.get(id);
      const second = judge(current);
      if (second === "done") {
        return { skipped: true, result: null, note: current!.note, withoutLedger: false };
      }
      if (second === "busy") {
        return { skipped: true, result: null, note: "already being applied", withoutLedger: false };
      }
      await ledger.put(id, reserve());
    }
  } catch (e) {
    ledgerWritable = false;
    await notifyOwner(
      `Could not record Stripe event ${id} as processed (${String(e)}). It was applied, but a ` +
        `duplicate delivery would be applied again. Check where customer records are stored ` +
        `(DATABASE_URL / the .run/ directory).`,
    );
  }

  try {
    const result = await run();
    if (ledgerWritable) {
      try {
        const row = await ledger.get(id);
        await ledger.put(id, {
          id,
          at: row?.at ?? new Date().toISOString(),
          note: typeof result === "string" ? result : "applied",
        });
      } catch (e) {
        console.warn(`[stripe-events] could not update the note for ${id}: ${String(e)}`);
      }
      await prune();
    }
    return { skipped: false, result, note: null, withoutLedger: !ledgerWritable };
  } catch (e) {
    // The handler failed: release the reservation so Stripe's retry can work.
    if (ledgerWritable) {
      try {
        await ledger.delete(id);
      } catch (inner) {
        console.warn(`[stripe-events] could not release ${id}: ${String(inner)}`);
      }
    }
    throw e;
  }
}
