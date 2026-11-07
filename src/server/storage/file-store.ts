/**
 * THE FILE DRIVER — the behaviour this app had before the storage interface
 * existed, kept byte-for-byte.
 *
 * Same paths, same env overrides, same on-disk format. That is the point: if the
 * driver changed how a record was written, every test that reads `.run/*.json`
 * would be testing something the running app no longer does. So the layout is a
 * per-store declaration (`FileLayout`), not a new format:
 *
 *   map      { "<key>": {…}, … }            users.json, sessions.json, comps.json
 *   array    [ {…}, {…} ]                   leads.json
 *   wrapped  { "events": [ {…}, … ] }       stripe-events.json
 *   jsonl    {…}\n{…}\n                     affiliate-clicks.jsonl
 *
 * The one thing that is NEW is `create()`: today a signup and a Stripe
 * reservation are both read-modify-write with nothing stopping two processes
 * interleaving. The interface promises insert-if-absent is atomic, so this
 * driver takes an exclusive lock file around the read-modify-write. The lock is
 * transient (created and removed inside one call), so the data files are
 * untouched in shape.
 *
 * A corrupt file reads as EMPTY, exactly as the hand-written loaders did: a
 * broken accounts file must not take the site down, and every caller of these
 * stores already treats "no record" as a normal answer.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ensureRunDir, writeRunFile } from "../run-dir";
import type { StorageBackend, Store, StoreEntry } from "./types";

/** How a store's records are laid out in its file. Declared per store. */
export type FileLayout =
  /** `{ key: value }` — the key is the object key, so it round-trips for free. */
  | { kind: "map" }
  /** A JSON array of values; the key is derived from each value. */
  | { kind: "array"; keyOf: (value: any) => string }
  /** `{ <field>: [values] }` — an array under one named field. */
  | { kind: "wrapped"; field: string; keyOf: (value: any) => string }
  /** One JSON document per line, append order preserved. */
  | { kind: "jsonl"; keyOf: (value: any) => string };

export interface FileStoreOptions {
  name: string;
  /** Resolved on EVERY call — the env var behind it can change inside a test. */
  file: () => string;
  layout: FileLayout;
}

/** How long to wait for another process's write before proceeding unlocked. */
const LOCK_WAIT_MS = 5000;
/** A lock file older than this belonged to a process that died. */
const LOCK_STALE_MS = 30_000;

/**
 * Give every value a key, disambiguating duplicates with `#2`, `#3`, …
 *
 * Needed because an array/JSONL file stores values without their keys. Order is
 * preserved on every write, so the same values always produce the same keys on
 * a re-read. (A delete renumbers later duplicates; no store that uses this
 * layout deletes, and the click log is append-only by design.)
 */
function keyed(entries: Array<[string, unknown]>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Map<string, number>();
  for (const [base, value] of entries) {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, value);
  }
  return out;
}

/** Read a store's file into an ordered key→value map. Absent/corrupt ⇒ empty. */
function load(file: string, layout: FileLayout): Map<string, unknown> {
  if (!existsSync(file)) return new Map();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }

  if (layout.kind === "jsonl") {
    const rows: Array<[string, unknown]> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const value = JSON.parse(trimmed);
        rows.push([layout.keyOf(value), value]);
      } catch {
        /* a half-written last line is skipped, not fatal */
      }
    }
    return keyed(rows);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }

  if (layout.kind === "map") {
    const out = new Map<string, unknown>();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        out.set(key, value);
      }
    }
    return out;
  }

  const list =
    layout.kind === "array"
      ? Array.isArray(parsed)
        ? parsed
        : []
      : Array.isArray((parsed as Record<string, unknown> | null)?.[layout.field])
        ? ((parsed as Record<string, unknown>)[layout.field] as unknown[])
        : [];
  return keyed(list.map((value) => [layout.keyOf(value), value] as [string, unknown]));
}

/** Write a key→value map back out in the store's declared layout. */
function save(file: string, layout: FileLayout, records: Map<string, unknown>): void {
  const values = [...records.values()];
  let text: string;
  switch (layout.kind) {
    case "map": {
      const obj: Record<string, unknown> = {};
      for (const [key, value] of records) obj[key] = value;
      text = JSON.stringify(obj, null, 2);
      break;
    }
    case "array":
      text = JSON.stringify(values, null, 2);
      break;
    case "wrapped":
      text = JSON.stringify({ [layout.field]: values }, null, 2);
      break;
    case "jsonl":
      text = values.length ? `${values.map((v) => JSON.stringify(v)).join("\n")}\n` : "";
      break;
  }
  writeRunFile(file, text);
}

/**
 * Run `fn` holding an exclusive lock on `file`.
 *
 * `wx` (O_CREAT|O_EXCL) is the atomic primitive: exactly one process can create
 * the lock file. If the wait times out we proceed WITHOUT the lock rather than
 * wedge a signup or a webhook for ever — the write is still a whole-file
 * replace, so the worst case is the pre-existing behaviour, not a corrupt file.
 */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  ensureRunDir(dirname(file));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        /* the holder removed it between our open and our stat — just retry */
      }
      if (Date.now() > deadline) return fn();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

export class FileStore<T = unknown> implements Store<T> {
  readonly name: string;
  readonly backend: StorageBackend = "file";
  private readonly options: FileStoreOptions;

  constructor(options: FileStoreOptions) {
    this.options = options;
    this.name = options.name;
  }

  private path(): string {
    return this.options.file();
  }

  private read(): Map<string, unknown> {
    return load(this.path(), this.options.layout);
  }

  async get(key: string): Promise<T | null> {
    const records = this.read();
    return (records.has(key) ? (records.get(key) as T) : null);
  }

  async put(key: string, value: T): Promise<void> {
    const file = this.path();
    const records = this.read();
    records.set(key, value);
    save(file, this.options.layout, records);
  }

  async create(key: string, value: T): Promise<boolean> {
    const file = this.path();
    // The whole point of the method: check-then-write under one exclusive lock.
    return withLock(file, () => {
      const records = load(file, this.options.layout);
      if (records.has(key)) return false;
      records.set(key, value);
      save(file, this.options.layout, records);
      return true;
    });
  }

  async delete(key: string): Promise<boolean> {
    const file = this.path();
    return withLock(file, () => {
      const records = load(file, this.options.layout);
      if (!records.has(key)) return false;
      records.delete(key);
      save(file, this.options.layout, records);
      return true;
    });
  }

  async list(prefix?: string): Promise<StoreEntry<T>[]> {
    const records = this.read();
    const out: StoreEntry<T>[] = [];
    for (const [key, value] of records) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({ key, value: value as T });
    }
    return out;
  }
}
