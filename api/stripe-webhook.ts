// Vercel serverless function: /api/stripe-webhook on the custom domain.
//
// WHY THIS EXISTS ONLY TO SAY "WRONG HOST":
// the endpoint lives on the platform deployment (serve-static.ts), where the
// raw request body is available and the HMAC is checked against it. A Vercel
// Node function receives an already-parsed JSON body, and re-serialising it
// changes the bytes — so `stripe-signature` can never be verified here, and
// forwarding it onward would either fail the signature or (worse) tempt someone
// into skipping verification. Rather than 404/405 silently, answer 421 with the
// endpoint that does work.
//
// SELF-CONTAINED — no relative imports (a relative import once stopped a
// deployed function from loading at all, see api/signup.ts).
const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";

export default function handler(req: any, res: any): void {
  res.statusCode = 421;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(
    JSON.stringify({
      ok: false,
      error: "Stripe events are received on the platform host, not this domain",
      use: `${PLATFORM_API_URL}/api/stripe-webhook`,
      why: "the signature is checked against the raw request body, which a function on this host cannot see",
      method: req?.method || null,
    }),
  );
}
