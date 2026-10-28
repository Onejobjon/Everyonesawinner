import { Link } from "react-router-dom";
import { Ext, H2, LegalLayout, P, UL } from "../components/legal";

/**
 * /terms — terms of use.
 *
 * Written to describe the site as it actually is:
 *   - no paid plan can be bought (Stripe is one-time-priced / checkout closed),
 *   - offer rows carry the date we checked them (checked_on in free-bets.ts) and
 *     some are openly marked unverified,
 *   - licence evidence is a licence check, not a terms check,
 *   - operator links go straight to the operator with no tracking parameters
 *     and there is no affiliate arrangement in place today.
 * Nothing is promised about uptime, accuracy or outcomes.
 */

const LAST_UPDATED = "28 October 2026";
const CONTACT = "support@everyonesawinner.uk";

export default function Terms() {
  return (
    <LegalLayout title="Terms of use">
      <p className="mb-6 text-sm leading-6 text-gray-500 dark:text-gray-400">
        Last updated: {LAST_UPDATED}
      </p>

      <H2>1. What this is</H2>
      <P>
        Everyone's A Winner is a comparison and calculation tool. We show odds from UK bookmakers and
        exchanges side by side, list welcome offers with the evidence we have for them, and calculate
        what a matched bet returns.
      </P>
      <P>
        We are not a bookmaker and we are not an exchange. We do not place bets for you, we do not
        take bets, and we do not hold your money. Every bet you place is between you and the
        bookmaker or exchange you place it with.
      </P>

      <H2>2. Not advice</H2>
      <P>
        Nothing on this site is betting, financial, investment or tax advice, and nothing on it is a
        recommendation that you place a particular bet. The tools show what the numbers work out to;
        every decision, and every stake, is yours. If you want advice on your own circumstances, ask
        a regulated adviser.
      </P>

      <H2>3. Accuracy of odds and offers</H2>
      <P>
        Odds change constantly and bookmakers withdraw offers without notice. Prices on this site can
        be minutes out of date and may be unavailable by the time you reach the bookmaker.
      </P>
      <P>
        Offer rows show the date we checked them, and some are marked as unverified — that mark means
        we could not read the offer on the bookmaker's own page, so the row is only what the offer
        was described as. We cannot confirm that an offer is still running. Where a bookmaker's terms
        and our row disagree, the bookmaker's terms apply, and the bookmaker decides whether you
        qualify.
      </P>

      <H2>4. Licence evidence</H2>
      <P>
        Where a row names a licensee and a Gambling Commission account number, that is a licence
        check only. It says the operator holds a licence from the Gambling Commission; it is not a
        check of that operator's terms, it is not a statement that an offer is available, and it is
        not an endorsement of the operator.
      </P>

      <H2>5. 18+ and lawful use</H2>
      <P>
        This site is for adults aged 18 or over. You are responsible for using it lawfully where you
        are, and for complying with each bookmaker's own terms. Matched betting is not illegal in the
        UK, but bookmakers commonly restrict or close accounts they believe are matched betting, and
        they can withhold a free bet. That is a risk you carry, not something we can prevent.
      </P>

      <H2>6. Your account</H2>
      <P>
        Keep your password to yourself — we cannot recover it for you, because we cannot read it.
        Do not share an account. We may suspend or close an account that is being used to attack,
        overload or probe the service, or that is being used to break these terms.
      </P>

      <H2>7. Payments</H2>
      <P>
        No paid plan can currently be purchased. Checkout is closed, and no payment has been taken
        from anyone. Nothing on this site is on sale today.
      </P>
      <P>
        If and when checkout opens, the price, the billing period and how to cancel will be published
        on the plan page before you pay anything. You will not be charged without seeing them first.
      </P>

      <H2>8. Availability</H2>
      <P>
        The tools depend on a third-party odds feed. They can be slow, incomplete or unavailable when
        that feed is, and a search can return fewer fixtures than you expect. We give no uptime
        guarantee, and we may change or withdraw a tool at any time.
      </P>

      <H2>9. Liability</H2>
      <P>
        We are not liable for betting losses, for a missed or withdrawn offer, for a price that moved
        before you placed a bet, or for a bookmaker restricting your account. Use the numbers here as
        a calculation, not a promise of what you will receive.
      </P>
      <P>
        Nothing in these terms limits our liability for fraud, or for death or personal injury caused
        by our negligence, or anything else that cannot lawfully be limited.
      </P>

      <H2>10. Links to bookmakers</H2>
      <P>
        Links to bookmakers take you to the bookmaker's own site, and that site's terms and privacy
        notice govern what happens there. We are not responsible for their content or their conduct.
        Read the offer's terms on the bookmaker's page before you stake anything.
      </P>
      <P>
        There is no affiliate arrangement in place today: an offer links straight to the operator's
        own address, with no tracking parameter and no commission to us. If we ever enter into such
        an arrangement, it will be disclosed on this page before it applies.
      </P>

      <H2>11. Governing law</H2>
      <P>
        These terms are governed by the law of England and Wales, and any dispute will be dealt with
        by the courts of England and Wales.
      </P>

      <H2>12. Contact</H2>
      <P>
        Write to{" "}
        <a
          href={`mailto:${CONTACT}`}
          className="underline hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          {CONTACT}
        </a>
        . What we do with your details is set out in our{" "}
        <Link
          to="/privacy"
          className="underline hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          privacy notice
        </Link>
        . If gambling is causing you harm, see <Ext href="https://www.begambleaware.org">BeGambleAware.org</Ext>.
      </P>
    </LegalLayout>
  );
}
