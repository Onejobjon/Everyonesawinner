/**
 * THE ONE BILLING SWITCH.
 *
 * WHY A SWITCH AT ALL (2026-11-03): the Stripe account is an EXPRESS account. It
 * cannot create subscriptions, and every price on it today is one-time. So the
 * whole billing surface — checkout creation AND the webhook that changes anyone's
 * access — has to be provably INERT until the owner has reconnected Stripe and
 * created three recurring prices. "Provably" means one environment variable that
 * every billing path reads, defaulting to OFF, so a test can show that with it off
 * nothing can be charged and nobody's access can change.
 *
 * ONE FLAG, BOTH DIRECTIONS. The flag gates the session-creation endpoint and the
 * webhook handler together, on purpose:
 *   • with it OFF no subscription can exist, so a webhook that granted access
 *     could only be acting on a forged, replayed or stale event;
 *   • when the owner reconnects Stripe there is exactly ONE thing to switch on,
 *     not two that can be set inconsistently.
 *
 * It is read at call time (never cached at module load), so a restart picks up a
 * change and a test can flip it inside one process.
 */

/** The environment variable the owner sets. Documented in the readiness report. */
export const CHECKOUT_FLAG = "CHECKOUT_ENABLED";

/**
 * Values that switch billing ON. Anything else — including unset, "", "0",
 * "false", "off", "no", and any typo — leaves it OFF. Fails closed: the safe
 * answer is the default answer.
 */
const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);

export function isCheckoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CHECKOUT_FLAG] || "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/** The machine-readable refusal code (the client keys off this). */
export const CHECKOUT_DISABLED_CODE = "checkout_disabled";

/**
 * The refusal message a human reads. Deliberately says what IS true (nothing can
 * be bought, nothing can be granted) rather than "try again later".
 */
export const CHECKOUT_DISABLED_MESSAGE =
  "Billing is switched off on this deployment. No plan can be bought and no payment " +
  "provider event can change anyone's access. The owner switches it on with " +
  `${CHECKOUT_FLAG}=on once the Stripe account can take subscription payments.`;
