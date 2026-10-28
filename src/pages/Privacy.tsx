import { Ext, H2, LegalLayout, P, PlaceholderNote, UL } from "../components/legal";

/**
 * /privacy — the privacy notice.
 *
 * Every statement here was checked against the code that actually runs:
 *   leads     src/server/leads.ts   (name, email, source, createdAt → JSON file
 *                                    or the Postgres `leads` table)
 *   accounts  src/server/users.ts   (name, email, scrypt hash + per-user salt,
 *                                    plan, subscription flag, createdAt)
 *   sessions  src/server/sessions.ts (32-byte random token, email, 30-day TTL)
 *   browser   src/lib/auth.tsx (`eaw_session`), src/lib/odds-api.ts (10-minute
 *             odds cache), LS_KEY in LayBets.tsx / BetBuilder.tsx (tool settings)
 *   fonts     index.html (fonts.googleapis.com stylesheet)
 *   alerts    src/server/alerts.ts (Telegram + Resend, owner-facing only)
 *   billing   src/server/stripe-webhook.ts (email + plan, only on a payment)
 *
 * No retention period is stated because none exists in the code — the notice
 * says so plainly rather than inventing one. No company name, number or
 * registered address is given: none is on file, so it is a marked placeholder.
 */

const LAST_UPDATED = "28 October 2026";
const CONTACT = "support@everyonesawinner.uk";

export default function Privacy() {
  return (
    <LegalLayout title="Privacy notice">
      <p className="mb-6 text-sm leading-6 text-gray-500 dark:text-gray-400">
        Last updated: {LAST_UPDATED}
      </p>

      <H2>1. Who we are</H2>
      <P>
        Everyone's A Winner is a comparison and calculation tool for matched betting. This notice
        explains what we hold about you, why we hold it, and what you can ask us to do with it.
      </P>
      <P>
        For anything in this notice — including a request to delete your details — write to{" "}
        <a
          href={`mailto:${CONTACT}`}
          className="underline hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          {CONTACT}
        </a>
        .
      </P>
      <PlaceholderNote>Registered company details are being added.</PlaceholderNote>

      <H2>2. What we collect</H2>
      <P>
        <strong className="font-semibold text-gray-900 dark:text-gray-100">
          If you join the waitlist
        </strong>{" "}
        (the "Keep me posted" form on the homepage or the free-bets page): your first name, your
        email address, the page you submitted the form from, and the date and time you submitted
        it. The form posts to our own <code className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em] dark:bg-gray-800">/api/leads</code>{" "}
        endpoint and the record is written either to a JSON file on our host's disk or, when a
        database is connected, to a <code className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em] dark:bg-gray-800">leads</code>{" "}
        table. Submitting the same email twice updates the existing record rather than creating a
        second one.
      </P>
      <P>
        <strong className="font-semibold text-gray-900 dark:text-gray-100">
          If you create an account
        </strong>
        : your name, your email address, a one-way scrypt hash of your password together with a
        random per-user salt, your plan, whether a subscription is recorded as active, and the date
        the account was created. We never store the password itself.
      </P>
      <P>
        <strong className="font-semibold text-gray-900 dark:text-gray-100">
          If you log in
        </strong>
        : we issue a random 32-byte session token and keep it on our server with your email address
        and a 30-day expiry. The same token is stored in your browser's local storage under the key{" "}
        <code className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em] dark:bg-gray-800">eaw_session</code>{" "}
        so you stay logged in between visits.
      </P>
      <P>
        <strong className="font-semibold text-gray-900 dark:text-gray-100">
          Browser storage we set
        </strong>
        : cached odds so the same prices are not fetched over and over (kept for 10 minutes), your
        saved settings for the Lay Bet Finder and the Bet Builder, and the session token above.
        This storage is not a cookie and it is not readable by any other website.
      </P>
      <P>
        <strong className="font-semibold text-gray-900 dark:text-gray-100">
          Server logs
        </strong>
        : like any web server, ours records the request and the IP address it came from.
      </P>

      <H2>3. Why we hold it</H2>
      <UL>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">Waitlist</strong> — to
          contact you when the product opens. Nothing is being sent today. You can withdraw at any
          time by emailing us, and we will delete the lead.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">Account</strong> — to
          give you access to what you have, and to work out which tools your plan can open.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">Logs</strong> — to run
          the service and to secure it.
        </li>
      </UL>

      <H2>4. Passwords</H2>
      <P>
        Your password is put through scrypt — a deliberately slow one-way hash — with a random salt
        unique to your account, and only the result is stored. We cannot read your password, and we
        cannot tell you what it is if you forget it.
      </P>

      <H2>5. How long we keep it</H2>
      <P>
        Session tokens expire after 30 days, after which the token no longer resolves to anything.
      </P>
      <P>
        There is currently no retention period for leads or accounts: we keep them until you ask us
        to delete them. That is the honest answer as the code stands — we would rather say it than
        invent a period we do not actually apply.
      </P>

      <H2>6. Who else sees it</H2>
      <UL>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">Google Fonts</strong> —
          every page loads a font file from fonts.googleapis.com, and that request carries your IP
          address to Google.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">
            Our hosting provider
          </strong>{" "}
          — the server runs on their infrastructure and their server logs include IP addresses.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">The Odds API</strong> —
          we send odds requests to them. Those requests contain no personal data about you.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">Stripe</strong> — only
          if a payment is ever completed. Stripe would then hold your payment details under its own
          privacy notice; we would never see your card number.
        </li>
        <li>
          <strong className="font-semibold text-gray-900 dark:text-gray-100">
            Telegram and a private email service
          </strong>{" "}
          — used only for our own internal opportunity alerts, which go to us. No customer data is
          sent to either.
        </li>
      </UL>

      <H2>7. What we never do</H2>
      <P>
        We do not sell your data, and we do not share it with bookmakers. If that ever changed,
        this notice would say so before it happened.
      </P>

      <H2>8. Your rights</H2>
      <P>You can ask us to:</P>
      <UL>
        <li>tell you what we hold about you (access);</li>
        <li>correct anything that is wrong (rectification);</li>
        <li>delete it (erasure);</li>
        <li>give it to you in a portable form (portability);</li>
        <li>stop processing it, or object to a particular use (objection).</li>
      </UL>
      <P>
        Write to{" "}
        <a
          href={`mailto:${CONTACT}`}
          className="underline hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          {CONTACT}
        </a>{" "}
        and we will act on it. If you are not happy with how we handled it, you can complain to the
        Information Commissioner's Office at <Ext href="https://ico.org.uk">ico.org.uk</Ext>.
      </P>

      <H2>9. 18+</H2>
      <P>
        This site is for adults. You must be 18 or over to use it, and we do not knowingly hold data
        on anyone under 18. If you believe a minor has given us their details, tell us and we will
        delete them.
      </P>

      <H2>10. Cookies and tracking</H2>
      <P>
        We set no advertising cookies and no analytics cookies. There is no tracking pixel, no
        third-party analytics script and no advertising identifier on this site. The browser storage
        described in section 2 is your session and your own tool settings, and it exists to make the
        site work, not to follow you anywhere else.
      </P>

      <H2>11. Changes to this notice</H2>
      <P>
        When this notice changes, the date at the top changes with it. This version was last updated
        on {LAST_UPDATED}.
      </P>
    </LegalLayout>
  );
}
