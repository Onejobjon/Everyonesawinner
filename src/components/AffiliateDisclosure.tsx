import { commissionDisclosure, referralDisclosure } from "../lib/affiliates";

/**
 * The money disclosure.
 *
 * Two separate facts, each rendered only while it is true:
 *
 *  - the REFERRAL disclosure, when an operator link is the owner's own referral
 *    link (src/lib/affiliates.ts, `referral: true`). That is a material
 *    interest, so it prints in plain English next to the links.
 *  - the COMMISSION disclosure, only once a real affiliate tag is configured —
 *    we are paid by nobody else today, so saying otherwise would be a false
 *    statement about money.
 */
export default function AffiliateDisclosure({ className = "" }: { className?: string }) {
  const referral = referralDisclosure();
  const commission = commissionDisclosure();
  if (!referral && !commission) return null;
  return (
    <>
      {referral && (
        <p
          data-testid="referral-disclosure"
          className={`text-xs leading-5 text-gray-500 dark:text-gray-400 ${className}`}
        >
          {referral}
        </p>
      )}
      {commission && (
        <p
          data-testid="affiliate-disclosure"
          className={`text-xs leading-5 text-gray-500 dark:text-gray-400 ${className}`}
        >
          {commission}
        </p>
      )}
    </>
  );
}
