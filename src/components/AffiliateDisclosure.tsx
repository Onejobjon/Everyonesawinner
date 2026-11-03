import { commissionDisclosure } from "../lib/affiliates";

/**
 * The commission disclosure.
 *
 * Renders NOTHING while no brand has an affiliate tag configured
 * (src/lib/affiliates.ts) — we are paid by nobody today, so saying otherwise
 * would be a false statement about money. It appears on its own the day a real
 * tag is set, and not before.
 */
export default function AffiliateDisclosure({ className = "" }: { className?: string }) {
  const text = commissionDisclosure();
  if (!text) return null;
  return (
    <p
      data-testid="affiliate-disclosure"
      className={`text-xs leading-5 text-gray-500 dark:text-gray-400 ${className}`}
    >
      {text}
    </p>
  );
}
