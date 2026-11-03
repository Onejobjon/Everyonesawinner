/**
 * TWO TELEGRAM CHANNELS, AND THE HARD RULE BETWEEN THEM.
 *
 * OWNER DEFECT (2026-11-03): everything the bot sent went to whichever single id
 * was in TELEGRAM_CHAT_ID — so a stall alarm, a delivery self-test or a billing
 * warning could land in the customer-facing "EAW alerts" group, and the alerts
 * themselves could land in the owner's DM by accident.
 *
 * The rule now:
 *   alerts  → TELEGRAM_ALERTS_CHAT_ID (falls back to TELEGRAM_CHAT_ID), a group is fine
 *   system  → TELEGRAM_ADMIN_CHAT_ID only, PRIVATE only, otherwise SUPPRESSED
 *             and logged — never redirected to the alerts channel.
 *
 * These tests pin the three cases that matter:
 *   1. a system message never posts to a group id;
 *   2. opportunity alerts still post (to the group);
 *   3. a missing/invalid admin id suppresses rather than leaks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  adminChatId,
  alertsChatId,
  isGroupChatId,
  isPrivateChatId,
  maySend,
  resolveChatId,
  systemSuppressionReason,
} from "../src/server/telegram-channels";

const GROUP = "-5018337058"; // the "EAW alerts" customer group
const OWNER_DM = "5640447870"; // the owner's private chat
const TOKEN = "123:test-token";

type Call = { url: string; body: { chat_id?: string; text?: string } };

/** Every send Telegram received, in order. */
let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

function stubFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string },
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, result: { message_id: 42 } }),
      text: async () => JSON.stringify({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response;
  }) as typeof fetch;
}

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ALERTS_CHAT_ID",
  "TELEGRAM_ADMIN_CHAT_ID",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  originalFetch = globalThis.fetch;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the channel rule, without a network call", () => {
  test("a group id is negative; a private chat id is a positive integer", () => {
    expect(isGroupChatId(GROUP)).toBe(true);
    expect(isGroupChatId(OWNER_DM)).toBe(false);
    expect(isPrivateChatId(OWNER_DM)).toBe(true);
    expect(isPrivateChatId(GROUP)).toBe(false);
    expect(isPrivateChatId("")).toBe(false);
    expect(isPrivateChatId("@some_channel")).toBe(false); // a username is not provably private
  });

  test("alerts resolve to TELEGRAM_ALERTS_CHAT_ID, with TELEGRAM_CHAT_ID as the fallback", () => {
    expect(alertsChatId({ TELEGRAM_ALERTS_CHAT_ID: GROUP, TELEGRAM_CHAT_ID: OWNER_DM })).toBe(GROUP);
    // Machine replacement: only the legacy variable survived — do not go silent.
    expect(alertsChatId({ TELEGRAM_CHAT_ID: OWNER_DM })).toBe(OWNER_DM);
    expect(alertsChatId({})).toBe("");
  });

  test("system resolves to the admin chat ONLY — never to the alerts id or the legacy id", () => {
    expect(adminChatId({ TELEGRAM_ADMIN_CHAT_ID: OWNER_DM })).toBe(OWNER_DM);
    expect(
      adminChatId({ TELEGRAM_ADMIN_CHAT_ID: GROUP, TELEGRAM_ALERTS_CHAT_ID: GROUP, TELEGRAM_CHAT_ID: OWNER_DM }),
    ).toBeNull();
    expect(adminChatId({ TELEGRAM_CHAT_ID: OWNER_DM, TELEGRAM_ALERTS_CHAT_ID: GROUP })).toBeNull();
    expect(resolveChatId("system", { TELEGRAM_ADMIN_CHAT_ID: OWNER_DM })).toBe(OWNER_DM);
  });

  test("the suppression reason names the actual problem", () => {
    expect(systemSuppressionReason({})).toContain("not set");
    expect(systemSuppressionReason({ TELEGRAM_ADMIN_CHAT_ID: GROUP })).toContain("GROUP");
    expect(systemSuppressionReason({ TELEGRAM_ADMIN_CHAT_ID: "@chan" })).toContain("not a private");
  });

  test("maySend refuses a group for system messages and allows it for alerts", () => {
    expect(maySend("system", GROUP)).toBe(false);
    expect(maySend("system", OWNER_DM)).toBe(true);
    expect(maySend("alerts", GROUP)).toBe(true);
    expect(maySend("system", null)).toBe(false);
  });
});

describe("the send site enforces it", () => {
  test("a SYSTEM message never posts to a group id", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERTS_CHAT_ID = GROUP;
    process.env.TELEGRAM_CHAT_ID = GROUP;
    process.env.TELEGRAM_ADMIN_CHAT_ID = GROUP; // misconfigured: the admin id IS the group

    const { postTelegram } = await import("../src/server/alerts");
    const r = await postTelegram("stall alarm: no scan for 75 minutes", "system");

    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0); // nothing was sent, anywhere
  });

  test("a SYSTEM message with no admin id is suppressed, not leaked to the alerts chat", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERTS_CHAT_ID = GROUP;
    process.env.TELEGRAM_CHAT_ID = OWNER_DM; // legacy id present, and private — still not a system destination
    delete process.env.TELEGRAM_ADMIN_CHAT_ID;

    const { postTelegram } = await import("../src/server/alerts");
    const r = await postTelegram("delivery self-test", "system");

    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an opportunity ALERT still posts — to the alerts chat, which may be a group", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERTS_CHAT_ID = GROUP;
    process.env.TELEGRAM_ADMIN_CHAT_ID = OWNER_DM;

    const { postTelegram } = await import("../src/server/alerts");
    const r = await postTelegram("GREEN CASH: A v B — Home", "alerts");

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.chat_id).toBe(GROUP);
    expect(calls[0].url).toContain("/sendMessage");
  });

  test("a SYSTEM message with a private admin chat DOES post, to that chat only", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERTS_CHAT_ID = GROUP;
    process.env.TELEGRAM_ADMIN_CHAT_ID = OWNER_DM;

    const { postTelegram } = await import("../src/server/alerts");
    const r = await postTelegram("stall alarm: no scan for 75 minutes", "system");

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.chat_id).toBe(OWNER_DM);
    expect(calls[0].body.chat_id).not.toBe(GROUP);
  });

  test("the owner notification path (billing alarms) obeys the same rule", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERTS_CHAT_ID = GROUP;
    process.env.TELEGRAM_ADMIN_CHAT_ID = GROUP;

    const { notifyOwner, recentOwnerAlerts } = await import("../src/server/notify-owner");
    const before = recentOwnerAlerts().length;
    const sent = await notifyOwner("checkout landed on an address with no account");

    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
    // Still recorded in-process, so the message is not lost with the send.
    expect(recentOwnerAlerts().length).toBe(before + 1);

    // And with a private admin chat it does send, to the owner's DM.
    process.env.TELEGRAM_ADMIN_CHAT_ID = OWNER_DM;
    expect(await notifyOwner("second attempt")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.chat_id).toBe(OWNER_DM);
  });
});
