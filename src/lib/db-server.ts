import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

const DB_PATH = import.meta.dir
  ? `${import.meta.dir}/../../data.db`
  : "/home/team/shared/site/data.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { create: true });
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA foreign_keys=ON");
    initTables(_db);
  }
  return _db;
}

function initTables(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS dashboard (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      total_profit REAL NOT NULL DEFAULT 0,
      completed_offers INTEGER NOT NULL DEFAULT 0,
      active_offers TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS odds_cache (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      sport_key TEXT NOT NULL
    )
  `);
}

export function seedDashboard(userId: string) {
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO dashboard (id, user_id, total_profit, completed_offers, active_offers) VALUES (?, ?, 0, 0, '[]')",
    [randomUUID(), userId]
  );
}

export function getDashboard(userId: string) {
  const db = getDb();
  return db.query("SELECT * FROM dashboard WHERE user_id = ?").get(userId) as {
    total_profit: number;
    completed_offers: number;
    active_offers: string;
  } | undefined;
}

export function updateDashboardProfit(userId: string, profit: number) {
  const db = getDb();
  db.run("UPDATE dashboard SET total_profit = total_profit + ? WHERE user_id = ?", [
    profit,
    userId,
  ]);
}

export function incrementCompletedOffers(userId: string) {
  const db = getDb();
  db.run("UPDATE dashboard SET completed_offers = completed_offers + 1 WHERE user_id = ?", [
    userId,
  ]);
}

export function addActiveOffer(userId: string, offer: object) {
  const db = getDb();
  const row = db
    .query("SELECT active_offers FROM dashboard WHERE user_id = ?")
    .get(userId) as { active_offers: string } | undefined;
  if (row) {
    const offers = JSON.parse(row.active_offers);
    offers.push({ ...offer, addedAt: new Date().toISOString() });
    db.run("UPDATE dashboard SET active_offers = ? WHERE user_id = ?", [
      JSON.stringify(offers),
      userId,
    ]);
  }
}