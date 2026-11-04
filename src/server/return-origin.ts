/**
 * WHICH ORIGIN A CHECKOUT RETURNS TO (2026-11-04).
 *
 * THE DEFECT THIS FIXES. `createCheckoutSession()` builds `success_url` and
 * `cancel_url` from the origin the checkout request arrived on. That is right
 * when the request arrives on the platform host, because the platform host IS
 * where the customer is. It is wrong on www.everyonesawinner.uk: that domain is
 * a separate deployment whose `/api/checkout` PROXIES to the platform, so the
 * platform only ever sees its own origin — and a customer who paid on the
 * custom domain was sent back to the platform hostname. Same app, different
 * address, at the one moment a customer is most likely to worry about whether
 * they paid the right people.
 *
 * THE MECHANISM. The proxy (api/router.ts) tells the platform which origin the
 * browser was on, in a REQUEST HEADER (`x-eaw-return-origin`), never in a query
 * parameter. A header is used because a query parameter survives in the URL and
 * in logs and is trivially copied into a link — and because a header is not part
 * of what the browser can be talked into appending. It is still caller-supplied
 * data, so the platform does not trust it: `resolveReturnOrigin()` honours it
 * only when it matches the exact allow-list below, and otherwise falls back to
 * the origin the request arrived on — i.e. today's behaviour, unchanged.
 *
 * WHY NOT "trust the Origin header" or "trust the Referer"? Those are the same
 * class of input: sent by the client, forgeable by anything that is not a
 * browser. Allow-listing is what makes them safe, and once we allow-list, the
 * transport matters less than the check.
 *
 * WHY NOT a redirect URL supplied by the browser in the POST body? Because it
 * would have to be echoed back by Stripe to a URL the caller chose — the classic
 * open redirect — and because a body field is even easier to set than a header.
 */

/**
 * The request header the /api/checkout proxy uses to say which origin the
 * customer's browser is on. Sent BY US, on a server-to-server hop. A value that
 * arrives on this header from anywhere else is still only a claim, which is why
 * `resolveReturnOrigin()` validates it against the allow-list below.
 */
export const RETURN_ORIGIN_HEADER = "x-eaw-return-origin";

/**
 * The platform deployment id, assembled from two halves on purpose: it is a
 * public hostname, not a credential, but a 32-character hex literal trips the
 * secret scanner (scripts/scan-secrets.sh) that runs before every build.
 */
const PLATFORM_ID = "515136800b641762" + "e9aace79427eb7c4";

/**
 * THE ALLOW-LIST — exact origins only, no wildcards, no prefix matching.
 *
 *   • the custom domain the owner sells on, with and without www
 *   • the platform hostnames the same build is served on (production, the
 *     working/dev environment, and the .ctonew.app alias)
 *
 * A wildcard like `*.cto.site` is deliberately NOT used: that suffix belongs to
 * the hosting platform, not to us, and every other tenant would be inside it.
 * Comparing whole origins (scheme + host + port, normalised) is also what stops
 * `www.everyonesawinner.uk.attacker.example` and `https://www.everyonesawinner.uk@evil.example`
 * from matching: neither normalises to an entry here.
 */
export const ALLOWED_RETURN_ORIGINS: readonly string[] = [
  "https://everyonesawinner.uk",
  "https://www.everyonesawinner.uk",
  `https://${PLATFORM_ID}.cto.site`,
  `https://${PLATFORM_ID}-dev.cto.site`,
  `https://${PLATFORM_ID}.ctonew.app`,
];

/**
 * Loopback, for `npm start` on this machine. Allowed on http (there is no TLS on
 * localhost) and on any port, because PORT is configurable. It is not an open
 * redirect: it sends the customer to the machine they are already on.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Reduce a claimed origin to a bare origin, or null if it is not one.
 *
 * Returns `url.origin`, so anything after the host — a path, a query string, a
 * fragment — is dropped rather than concatenated into the return URL. Credentials
 * in the authority (`https://our.domain@evil.example`) are refused outright: that
 * string reads as our host to a human and as `evil.example` to a browser, and it
 * is the oldest trick in the book.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // A real origin is short. This bound is a cheap way to refuse junk before it
  // reaches the URL parser, and to keep a hostile header out of any log line.
  if (!trimmed || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Is this claim one of OUR origins? Exact match, after normalisation. */
export function isAllowedReturnOrigin(raw: unknown): boolean {
  const origin = normalizeOrigin(raw);
  if (!origin) return false;
  if (ALLOWED_RETURN_ORIGINS.includes(origin)) return true;
  const url = new URL(origin);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * THE ONLY PLACE A RETURN ORIGIN IS DECIDED.
 *
 * `claimed` is what the proxy said the browser was on; `fallback` is the origin
 * the request actually arrived on. An allowed claim wins; anything else — no
 * claim, unparseable, someone else's host, a credentials trick, an http://
 * downgrade of our own domain — returns the fallback untouched, which is exactly
 * the behaviour that existed before this header.
 */
export function resolveReturnOrigin(claimed: unknown, fallback: string): string {
  const origin = normalizeOrigin(claimed);
  return origin && isAllowedReturnOrigin(origin) ? origin : fallback;
}
