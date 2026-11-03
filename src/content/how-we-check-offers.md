# How we check the offers — and where our numbers come from

Everyone's A Winner would rather show a short list we can stand behind than a long one we cannot. This page says where every number on the site comes from — the odds, the lay prices, the offers and the profit figures — what we check, what we do not check, and how to repeat the checks yourself.

## The short version: each kind of number, and its source

- **Bookmaker odds** — read from a commercial sports-odds feed, the-odds-api.com, for UK bookmakers in decimal odds. A snapshot, not a live stream: a page reuses an answer for up to 10 minutes, and the background scan runs every 30 minutes.
- **Lay prices** — exchange prices that arrive inside that same feed, from Betfair. Betfair is the only exchange we show a lay price from.
- **Free-bet offers** — a list we keep and re-check ourselves, one row per operator, each carrying the licensee's name, its Gambling Commission account number and a link to the register.
- **Profit, lay stake and liability** — worked out in your own browser, from the numbers on the screen, by our own arithmetic. Nothing is stored, and nothing is estimated on your behalf.
- **Exchange commission** — one number for the whole site, 2% unless you change it, adjustable from 0% to 10%, and printed beside every figure that depends on it.

The rest of this page takes each of those in turn.

## 1. Is the operator licensed in Great Britain?

Every operator is checked against the Gambling Commission's public business register. We record what the register says: the licensed business name (the licensee — often not the name on the website) and its account number. Both appear on every row, with a link.

To repeat it in ten seconds:

1. Open `www.gamblingcommission.gov.uk/public-register/businesses`.
2. Search the licensee name or the account number shown on the row. Results live at `/public-register/businesses/results?business-search=` plus your term — so `/public-register/businesses/results?business-search=55149` goes straight to account 55149.
3. Check the name and account match what we published. If they do not, that is our mistake — tell us and we will fix or remove the row.

**A licence is not a promotion.** It proves the business holds a Gambling Commission licence. It does not prove this offer is running today, is available to you, or matches an old article's terms.

## 2. Does the link work?

Every link is requested and we record the date and the HTTP result — whether the page loaded, and where it sent us. A link that is dead, parked, or no longer belongs to that operator comes off the list.

## 3. We do not confirm an offer's terms

This is the part we cannot do. Bookmaker offer pages are usually blocked to anyone outside the UK and our checks run from outside it, so for most rows we can see the operator is licensed and its site is up, but we cannot read the current terms.

That is what `unverifiable` means: **we could not read this.** It does not mean "this is live" and it is not a recommendation. Before you deposit, read the offer on the bookmaker's own page — minimum stake, minimum odds, qualifying markets, expiry, exclusions. If our row and the bookmaker disagree, the bookmaker is right.

## 4. We do not quote a profit figure

You will not find an expected profit here, deliberately. What you keep from a free bet depends on the odds you match at and the commission you pay; a free bet matched at short odds keeps far less than one at long odds. A single "what this is worth" number is wrong for almost everyone reading it, and the figures we used to publish could not survive that check. So we publish none.

Every row carries the date it was checked. An old date is not a lie, it is the truth about how stale the row is — treat anything more than a few weeks old as a lead to verify, not a fact.

## 5. Where the odds come from

The prices we compare are read from a commercial sports-odds feed, the-odds-api.com. Our server asks that feed for UK bookmaker prices in decimal odds, and the page shows what came back. We do not scrape odds off bookmaker websites ourselves: the bookmakers listed against a match are the ones the feed returned for it.

A price is a **snapshot, not a live stream**, and two waits are built in on purpose:

- the page reuses an answer it already has for up to 10 minutes before asking again, so the same prices are not fetched over and over;
- the background scan that looks for matches runs every 30 minutes, and opening a page can ask for an extra scan if what we hold is more than five minutes old.

So a price on the oddsmatcher can be several minutes old, and a price in an alert can be up to half an hour old. The oddsmatcher says "Odds updated every 10 minutes" for that reason. Before you stake on a price, look at it on the bookmaker's own site.

## 6. Where the lay prices come from

Lay prices are exchange prices, and they are not a separate product we buy. They arrive inside the same odds feed, from **Betfair** — our provider carries Betfair's markets, and Betfair is the only exchange we will show a lay price from. If the feed has no Betfair lay price for a market, we show no lay price for it rather than fill the gap with something else.

**We do not use Smarkets.** Their API terms forbid using it to benchmark markets and prices, which is exactly what an oddsmatcher does, so no Smarkets price is turned into a lay quote on this site — even if one appears in the feed, it is ignored.

## 7. Where the free-bet offers come from

The offers are a list we write and re-check by hand, not something pulled live from the bookmakers. Every row carries its licensee, its Gambling Commission account number, the date it was checked, and a link to that entry on the register — so the licence claim is repeatable, not something you have to take on trust.

Offers that are **not licensed in Great Britain** are kept in a separate Global section and labelled with the jurisdiction the operator is licensed in. They are listed separately for that reason: they are not UK-licensed offers, and they should be read as a different thing.

Most rows are marked `unverifiable`. That is what it says: we could not read the current offer terms. It is not a tick, and it is not a recommendation. See sections 1 to 4 above for what we can and cannot confirm.

## 8. Where the profit figures come from

Every profit, lay stake and liability figure on this site is calculated **in your browser, from the numbers on the screen, at the moment you type them**. There is no table of stored results and no server doing the sums: change a stake, an odds, or the commission and every figure beside it changes with it. The calculator prints the worse of the two outcomes as its headline, because that is the only figure you are guaranteed whichever way the bet goes.

That is the strongest honest claim we have, so we will say it plainly: you can check our arithmetic yourself. Lay stake, liability and profit are the standard matched-betting formulas, at the odds and the commission printed next to the result. If a figure does not reproduce from those inputs, it is a bug — tell us and we will fix it or take it down.

## 9. Commission: 2% unless you change it

Exchange commission changes what a bet is worth, so it is never a hidden constant. It is **2% by default**, adjustable from **0% to 10%**, and one setting applies across the whole site — the calculator, the Lay Bet Finder and the Bet Builder all use the number you set. Every figure that depends on it is labelled with the rate used.

2% is a default, not a claim about your account: Betfair charges per market, and often more on the main football markets, so set it to what you actually pay. Every figure on the page follows.

## 10. How we are paid

The way this site is meant to pay for itself is bookmaker affiliate links. If you open a bookmaker account through a link on this site and bet with them, that bookmaker may pay us a commission. It costs you nothing extra, and it never changes the odds we show, which price we call the best, or the order anything is listed in.

**Today no link carries an affiliate tag**, so we earn nothing from them: every operator link goes straight to the bookmaker's own page with nothing added. A disclosure appears on this page by itself the day the first link carries a tag, and not before. We will not print a claim about money nobody is paying us.

## 11. What we do not claim

- We do not guarantee that a price is current, or that an offer is still running.
- We do not claim the best price we found is the best price in the market — only that it is the best of the prices we were given.
- We do not publish an accuracy or uptime percentage, because we do not have a measurement we could stand behind.
- Terms change and offers are withdrawn, often without notice. Check the operator's own terms before you stake: minimum stake, minimum odds, qualifying markets, expiry and exclusions.
