import { Link } from "react-router-dom";
import { Ext, H2, LegalLayout, P, UL } from "../components/legal";

/**
 * /terms — terms of use.
 *
 * Written to describe the site as it actually is:
 *   - subscriptions renew automatically (owner decision 2026-11-02) and are
 *     cancelled by EMAIL — there is no self-serve cancel route in the code, so
 *     nothing here claims one. Same for updating a card,
 *   - offer rows carry the date we checked them (checked_on in free-bets.ts) and
 *     some are openly marked unverified,
 *   - licence evidence is a licence check, not a terms check,
 *   - operator links go straight to the operator with no tracking parameters
 *     and there is no affiliate arrangement in place today.
 * Nothing is promised about uptime, accuracy or outcomes.
 *
 * The trader's identity is stated in section 1: Jonathan Revill, sole trader,
 * trading as Everyone's A Winner, with the operating address. There is no
 * company and no company number, and no VAT registration, so neither is
 * printed; an unregistered "Ltd" would be an offence.
 *
 * Governing law is Northern Ireland (the business operates from Downpatrick),
 * worded so a UK consumer keeps the consumer law of their own part of the UK.
 */

const LAST_UPDATED = "3 November 2026";
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
        Everyone's A Winner is the trading name of Jonathan Revill, a sole trader, of 3 Clanmaghery
        Grove, Ballykinler, Downpatrick, BT30 8EX, in the United Kingdom. That is the address for
        anything to do with a subscription.
      </P>
      <P>
        We are not a registered company, so there is no company number, and we are not registered
        for VAT, so no VAT is added to any price shown on this site.
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

      <H2>7. Plans, prices and renewal</H2>
      <P>
        A subscription is a recurring payment, not a one-off purchase. The three plans and what they cost:
      </P>
      <UL>
        <li>
          <strong>Starter — £19.99 a month.</strong> The oddsmatcher, the profit calculator and the dashboard,
          including the instant-wins feed and your greens history.
        </li>
        <li>
          <strong>Pro — £29.99 a month.</strong> Everything in Starter, plus the Lay Bet Finder, the Bet Builder
          (the 2–4-leg lay planner) and the Same-Match Planner.
        </li>
        <li>
          <strong>Pro Annual — £269.99 a year.</strong> The same tools as Pro, paid for twelve months at once
          instead of month by month.
        </li>
      </UL>
      <P>
        The plan page and the checkout page show the price and the billing period of the plan you have chosen
        before you pay anything, in pounds sterling. Nothing is added at checkout that is not shown there.
      </P>
      <P>
        <strong>Each plan renews automatically until you cancel it</strong> — every month for Starter and Pro,
        every year for Pro Annual — using the card you paid with. We will not change the price of a subscription
        without emailing you first. A price change applies from your next renewal, and you can cancel before it
        does.
      </P>

      <H2>8. How to cancel</H2>
      <P>
        <strong>There is no cancel button in the account area yet, so cancellation is done by email.</strong>{" "}
        Write to{" "}
        <a href={`mailto:${CONTACT}`} className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
          {CONTACT}
        </a>{" "}
        from the address on your account, or reply to any email we have sent you about the subscription. A clear
        message is enough: you do not need a form, and you do not have to give a reason. We action it and confirm
        by email.
      </P>
      <P>
        Cancelling stops future billing. It does not end the plan on the spot: <strong>your access continues to
        the end of the period you have already paid for</strong>, and no further payment is taken from your card
        after that. We do not refund the unused part of a period just because you cancelled part-way through it —
        see section 10.
      </P>

      <H2>9. If a payment fails</H2>
      <P>
        We do not cut your access off the moment a card fails. If a renewal payment does not go through, we email
        you at the address on the account, we try the card again, and your plan stays open during a grace period.
        That email tells you the date the grace period ends.
      </P>
      <P>
        If the payment still has not gone through by that date, the subscription ends and the paid tools lock
        until it is settled. To update your card, email{" "}
        <a href={`mailto:${CONTACT}`} className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
          {CONTACT}
        </a>{" "}
        and we will send you a secure link to do it. You can also cancel during the grace period, and no further
        payment will be taken.
      </P>

      <H2>10. Refunds</H2>
      <P>We would rather say this plainly than leave it silent.</P>
      <P>We will refund:</P>
      <UL>
        <li>any charge taken after you have cancelled, and any charge taken in error or twice;</li>
        <li>a payment that goes through but does not activate your plan, if we cannot put it right;</li>
        <li>
          the rest of a period if <em>we</em> end your subscription for our own reasons, rather than because you
          broke these terms;
        </li>
        <li>a cancellation within your 14-day right, less the proportionate charge described in section 11.</li>
      </UL>
      <P>We will not refund:</P>
      <UL>
        <li>
          a period you have already had access to, just because you did not use the tools, or because you
          cancelled part-way through it;
        </li>
        <li>
          a plan because a bookmaker restricted or closed your account, or withdrew an offer — that is between
          you and the bookmaker (sections 3 and 5);
        </li>
        <li>
          a plan because the odds feed was briefly slow, incomplete or unavailable (section 12).
        </li>
      </UL>
      <P>
        If the paid tools are unavailable for a sustained period because of a fault at our end, email us. We will
        look at what happened and may refund part of it.
      </P>

      <H2>11. Your right to cancel within 14 days</H2>
      <P>
        You are buying from us at a distance — online, without meeting us — so you have a legal right to cancel
        within <strong>14 days</strong> of the day your subscription starts, without giving a reason. That right
        comes from the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013.
      </P>
      <P>
        When you subscribe you are asking us to start straight away rather than wait out those 14 days — that is
        what buying a plan means, and the tools unlock as soon as your payment clears. If you then cancel within
        the 14 days, <strong>we may charge a proportionate amount for the part of the period you have used</strong>{" "}
        and refund the rest. It is worked out from the number of days between your plan starting and your
        cancellation, against the price of the period you bought.
      </P>
      <P>
        <strong>How to use it:</strong> there is no online cancellation form. Email{" "}
        <a href={`mailto:${CONTACT}`} className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
          {CONTACT}
        </a>{" "}
        from the address on your account before the 14 days are up, using the wording below. Sending the email is
        enough — you do not need our agreement. We refund within 14 days of you telling us, to the payment method
        you paid with.
      </P>
      <P>Copy this into the email, filling in the brackets:</P>
      <P>
        <em>
          “I/We hereby give notice that I/We cancel my/our contract for the supply of the following service:
          Everyone's A Winner subscription (Starter / Pro / Pro Annual), ordered on [date]. Name: [your name].
          Email on the account: [your email]. Date: [today's date].”
        </em>
      </P>
      <P>
        That is the model cancellation form from those Regulations, adapted so it can be sent by email. If you
        would rather write your own words, that is fine too, as long as it is clear you are cancelling.
      </P>

      <H2>12. Availability</H2>
      <P>
        The tools depend on a third-party odds feed. They can be slow, incomplete or unavailable when
        that feed is, and a search can return fewer fixtures than you expect. We give no uptime
        guarantee, and we may change or withdraw a tool at any time.
      </P>

      <H2>13. Liability</H2>
      <P>
        We are not liable for betting losses, for a missed or withdrawn offer, for a price that moved
        before you placed a bet, or for a bookmaker restricting your account. Use the numbers here as
        a calculation, not a promise of what you will receive.
      </P>
      <P>
        Nothing in these terms limits our liability for fraud, or for death or personal injury caused
        by our negligence, or anything else that cannot lawfully be limited.
      </P>

      <H2>14. Links to bookmakers</H2>
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

      <H2>15. Governing law and where a dispute is heard</H2>
      <P>
        We operate from Downpatrick, County Down, so these terms are governed by the law of Northern Ireland.
        Northern Ireland is part of the United Kingdom, but it has its own courts and its own consumer law.
      </P>
      <P>
        If you are a consumer, nothing in these terms takes away any protection you have under the consumer law
        of the part of the UK you live in — England and Wales, Scotland or Northern Ireland. You can bring a
        claim against us in the courts of the part of the UK where you live, and you do not have to come to
        Northern Ireland to do it.
      </P>
      <P>
        If we ever need to bring a claim against you, we will bring it in the courts of the part of the UK where
        you live. If you would rather talk it through first — nearly always quicker and cheaper than a court —
        email{" "}
        <a href={`mailto:${CONTACT}`} className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
          {CONTACT}
        </a>{" "}
        and we will try to sort it out between us.
      </P>

      <H2>16. Contact</H2>
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
