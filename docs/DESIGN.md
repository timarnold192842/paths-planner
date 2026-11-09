# Paths — design

A planning tool for one household that answers one kind of question well:

> "If I make **this** choice instead of **that** one, what happens to my cash in the next few
> years, and to my wealth in the long run — and does the answer survive a bad market?"

The old Forecast app (budget-pages) models cash flows well but treats scenarios as an
afterthought: each scenario is a full copy of the plan, copies drift apart, an "apply to all"
switch tries to paper over that, and the only comparison is a price-path overlay for one stock.
Paths starts from the comparison and builds the model around it.

---

## 1. Core concepts

| Concept | What it is | Example |
|---|---|---|
| **Plan** | The single model of the world. Everything lives here exactly once. | Accounts, debts, cash flows, events, price models. |
| **Decision** | Something *you* control, with 2+ mutually exclusive **alternatives**. Plan items can belong to an alternative (they exist only when it is chosen), and alternatives can override fields of shared items. | *Rental condo*: Keep & rent · Sell Nov 2026 · Sell 2028. *Car loan*: Normal schedule · Pay off Jan 2027. *ACME vests*: Hold · Sell 50% at vest. |
| **Assumption** | Something you *don't* control, with **cases**. | *ACME price*: Bear · Mid · Bull. *Home appreciation*: 2% · 4%. *Inflation*: 2.5% · 4%. |
| **Scenario** | A small, named, durable selection: one alternative per decision + one case per assumption + optional scenario-only tweaks. | "Sell condo + pay off car loan (Mid)". |
| **Comparison** | A saved A/B(/C/D) setup: which scenarios, which is the reference, and which assumption to stress-test against. Re-runs on demand against the current plan. | "Sell vs rent the condo". |

Why this shape:

* **No copies.** A scenario stores only its *choices*, so fixing a typo in a paycheck, adding a
  repair, or updating a balance instantly applies to every scenario. Nothing to sync, nothing
  to drift. This removes the root cause of the old app's scenario bugs.
* **"Either all the sale transactions, or all the rental transactions"** is exactly an
  alternative that *owns* items. Picking *Sell* switches on the sale event and switches off
  rent income, management fees and repairs — as a unit.
* **Decisions vs assumptions** are separated on purpose. You compare *decisions*; you stress-test
  them against *assumptions*. "Selling the house is better" is only interesting if it is still
  true in the Bear case.
* **IDs, not names.** Every reference is by id, so renaming never breaks anything.

## 2. The plan model

All money is USD unless an item is denominated in a **unit** (e.g. ACME shares).

### Accounts (things you own)

`kind` drives defaults, liquidity, and the tax lens:

| kind | Liquid? | Back-of-envelope tax on withdrawal / liquidation |
|---|---|---|
| `cash` | yes | none |
| `brokerage` (taxable) | yes | LTCG on gain over cost basis |
| `equity` (unit-denominated, e.g. ACME) | yes (sellable) | LTCG on gain over average cost basis |
| `traditional` (401k / Trad IRA) | no | ordinary income (+10% penalty before 59½) |
| `roth` | no | none (assumes qualified) |
| `hsa` | no | none for qualified medical; ordinary (+20% before 65) otherwise |
| `education` (529) | no | none for qualified education; ordinary + 10% on earnings otherwise |
| `property` | no | selling costs + LTCG on gain (minus primary-residence exclusion) |
| `other` (watches, cars…) | no | none |

Fields: `name, kind, balance` (in its unit), `unitId?`, `growth` (annual %), `costBasis?`,
`liquid?` (override), `tags`.

### Debts

`name, balance, rate, payment, paymentDay, payoffDate?, securedBy?` (an account id: when the
asset is sold, the debt is paid from proceeds), `payFrom` (a funding waterfall).

### Cash flows (recurring or one-time)

`name, category, amount, unitId?, schedule, start, end?, growth (annual escalation), from, to`.

* **Schedules** — `once, daily, weekly, biweekly (every 14 days), semimonthly (chosen days,
  e.g. 15 & last), monthly, quarterly, annual`, plus a custom `every N months`.
* **Direction** — `from` empty = income; `to` empty = expense; both = transfer.
* **Funding waterfall** — `from` is an **ordered list**: "pay college from *Maya's 529* until it
  is empty, then from *Cash*." Each source is drained in order; the last source is allowed to
  go negative (that is the "can I sustain it?" signal). Withdrawals from tax-advantaged sources
  are grossed up for the estimated tax/penalty, and a flow can be marked *qualified*
  (education, medical) so 529 / HSA withdrawals stay tax-free.
* **While owned** — `whileOwned: accountId` stops the flow automatically when that asset is
  sold (property tax, insurance, HOA, repairs, rent income). First-class version of the old
  "contingent" link.
* **Share-denominated flows** — an RSU vest is a flow of ACME shares into the ACME account; its
  cost basis is the price on the vest date.

### Events (one-off structural changes)

| Event | Parameters | What the engine does |
|---|---|---|
| `sell` | asset, date, price (model or fixed), selling costs %, fixed costs, primary-residence exclusion, proceeds to | Zeroes the asset, pays off debts `securedBy` it, applies costs and estimated tax on the gain, deposits net proceeds, and ends every `whileOwned` flow. |
| `buy` | new asset (name, kind, price, growth), date, down payment from, closing costs %, mortgage (rate, years) | Creates the asset and an amortizing debt on that date. |
| `payoff` | debt, date, from (waterfall) | Pays the remaining balance in one lump sum. |
| `liquidate` | equity account, schedule, amount (shares, dollars, or % of holding), tax rate, to | Sells units at the modeled price on each date, books the gain against average basis, deposits after-tax proceeds. Models "sell $14k of ACME every vest" and "sell 50% at vest". |

### Price models (units)

A unit (ACME) has a current price and, **per case of an assumption**, a list of dated targets.
The price is linear between targets and grows at a configurable rate after the last one — the
same behaviour as the old app's price targets, but tied to an assumption instead of a hidden
"active scenario" flag.

### Borrowing (debts as instruments)

Any borrowing — a home-equity line, a 0% intro card or balance transfer, a personal loan, a
refinance — is one debt with terms, not a string of transactions:

| Term | Meaning |
|---|---|
| `start` + `balance` | Borrow this amount on this date (empty start = a debt you already have). |
| `proceedsTo` | Where the money goes: an account, or **another debt** it pays off (balance transfer, consolidation, refinance). `transferAll` sizes the loan to whatever that debt owes on the day. |
| `feePct` / `feeFixed` | Upfront fee, added to the balance. |
| `rate` + `rateSteps` | Rate over time (0% for 18 months, then 24.99%). |
| `paymentRule` | `fixed` payment · `amortize` over `termMonths` (recomputed when the rate changes) · `interestOnly` · `minimum` (greater of the $ floor or `minPct`% of balance + interest). |
| `payoffDate` | Pay the rest in full on a date (e.g. the day before a promo ends). |
| `creditLimit` | Makes it a line of credit: transfers and funding orders can **draw** from it. |
| `settings.safetyNet` | Credit lines to draw automatically when cash would otherwise go negative. |

## 3. Engine semantics

* Daily simulation from the plan's *as-of* date to the horizon (default 30 years).
* Per day, in a fixed order so results are deterministic:
  1. growth on accounts (daily-compounded annual rate) and interest on debts;
  2. events (buy → sell → payoff → liquidate);
  3. income flows, then transfers, then expenses (so a paycheck on the 15th covers bills on the 15th);
  4. scheduled debt payments (capped at the remaining balance).
* Every movement is written to a **ledger** (date, item, from, to, amount, tax, note) so any
  point on any chart can be explained.
* Outputs per run: daily series for every account and debt (USD), **net worth**, **after-tax
  net worth** (what you would keep if everything were liquidated that day), **liquid cash**,
  plus metrics:
  * net worth and after-tax net worth at 1, 3, 5, 10, 20 years and at the horizon — nominal
    and in today's dollars (inflation assumption);
  * lowest liquid balance and its date, first date below zero, days below the safety floor;
  * total interest, taxes, and transaction costs paid.
* Pure functions, no DOM. Run in the page (≈10–30 ms per scenario) and testable in Node.

* **Attribution.** Every day's change in net worth is split into income (by group), spending
  (by group), taxes, interest, fees and transaction costs, and growth (by asset type). Anything
  not explained explicitly goes to an "other" bucket, so the buckets always add up exactly —
  and a test keeps "other" at zero for ordinary plans. Summed per year it is an annual income
  statement; differenced between scenarios it explains *why* one path beats another.

## 4. The comparison experience

The Compare page is the heart of the app. For a reference **A** and challengers **B…**:

1. **Verdict strip** — one plain sentence per challenger, e.g. *"B ends $41k (2%) below A after
   30 years — negligible — but its lowest cash is $62k higher and it never dips below your
   $25k floor."* Thresholds for "negligible" are configurable.
2. **Net worth** — overlaid lines, with a **Difference** toggle that plots B − A against a zero
   line and marks the **crossover** date ("B overtakes A in Mar 2031").
3. **Liquidity** — liquid cash for each, the safety-floor line, and shaded shortfall periods.
   This is the "can I sustain it?" view.
4. **Scorecard** — side-by-side metrics with deltas (near term, long term, risk).
5. **What's different** — the exact choices, cases and tweaks that separate the scenarios.
6. **Stress test** — re-runs every scenario under each case of an assumption (e.g. ACME
   Bear/Mid/Bull) and shows the end-wealth delta and lowest cash in a grid. Answers "does the
   decision still win if the market doesn't cooperate?"

7. **What drives the difference** — the attribution buckets that differ most between the
   scenarios ("Interest on debt −$11k"), with the main driver named in the verdict.

Comparisons are saved and re-run against the current plan whenever you open them.

**Quick what-ifs.** On the overview you can flip decisions, switch assumption cases, or change
any value on top of the scenario you're viewing and see the verdict instantly. Nothing is
saved unless you choose "Save as scenario", which also creates the comparison.

**Check-ins.** "Update balances" shows what the plan expected each balance to be today next to
your actual numbers, re-baselines the plan to today, and records actual vs. expected net worth
so you can see whether you're running ahead of or behind plan over time.

## 5. UX principles

* **One place for each thing.** Plan editing, decisions, and scenarios are separate tabs; a
  scenario is never a place where you edit the plan by accident.
* **Scope is explicit.** When an item belongs to an alternative it shows a badge
  ("only in: Rental condo → Sell this spring").
* **Progressive disclosure.** Common fields first; tax, growth, waterfall, and ownership links
  in "More".
* **Mobile is first-class.** Charts and the scorecard work on a phone; the editor is a sheet.
* **Local-first.** Autosave in the browser, JSON export/import, and (phase 2) server sync.

## 6. Back-of-envelope taxes

Settings: ordinary income rate, long-term capital-gains rate, state rate, owner birth date (for
the 59½ / 65 penalty ages), primary-residence exclusion. Used for:

* grossing up withdrawals from traditional / HSA / 529 accounts in funding waterfalls;
* tax on gains at sale and liquidation (average-cost basis);
* the **after-tax net worth** lens, which makes "$100k in a 401k" and "$100k in cash" honestly
  comparable.

Deliberately out of scope for now: brackets, AMT, RMDs, depreciation recapture, wash sales,
state-specific rules. The goal is directional accuracy for decisions, not tax filing.

## 7. Persistence and sync

* **Phase 1 (now):** the whole plan is one JSON document (`schema: "paths/1"`) autosaved to
  local storage, with export/import and an importer for the old Forecast format (accounts,
  loans, transactions, units/price targets, fees, groups, contingent links, sale dates).
* **Phase 2:** a tiny sync service (Cloudflare Worker + D1, or the Render server planned for
  the portfolio app) storing the document with a revision number. Writes send `If-Match: rev`;
  a conflict shows "this plan changed on another device" with reload / keep-mine. The server
  keeps dated versions so any change can be rolled back. The app stays fully usable offline.

## 8. What else makes this a killer app (roadmap)

1. **Actuals history chart** — plot past check-ins against what each plan predicted (check-ins themselves are done).
2. **Decision templates** — guided "Sell vs rent a property", "Pay off a debt early",
   "Liquidate equity on a schedule", "Buy a house", "Refinance" wizards that create the
   decision, its alternatives, and the items in one step.
3. **Monte Carlo** on market assumptions — probability of a cash shortfall and P10/P50/P90
   wealth bands instead of three hand-picked paths.
4. **Sensitivity (tornado)** — which assumptions move end wealth the most.
5. **Goals** — "college fully funded", "financial independence date", "$X cushion by Y".
6. **Spending timeline** — how expenses step up and down over life stages (kids leave, house
   paid off) and what each step is worth over 30 years.
7. **Retirement mechanics** — Social Security estimate, RMDs, Roth conversion ladders.
8. **Plaid balance sync** — reuse the portfolio app's server to refresh balances automatically.

## 9. Architecture

* Static site on GitHub Pages; **no build step** (native ES modules).
* UI: Preact + htm (vendored, ~15 KB). Charts: uPlot (vendored, fast with 10k-point series).
* `src/engine/` — pure modules: schedules, prices, simulate, metrics, compare, tax, legacy import.
* `src/ui/` — components; `src/store.js` — state, undo, persistence.
* Tests: `node --test` against the engine, including a parity test that imports the old app's
  embedded plan and checks the new engine lands close to the old engine's numbers.
* The repo contains **no personal data**; the default plan is a fictional demo. Your plan
  lives in your browser (and later on your sync server).

## 10. Precise rules (from design review)

**Scenario compilation.** `compile(plan, scenario) → { plan', diagnostics }`:

1. Resolve the scenario chain (`basedOn`), child values winning; cycles are an error.
2. Pick one alternative per decision (scenario choice → decision default) and one case per
   assumption (stress-test override → scenario choice → assumption default).
3. Keep an item only if its `when` predicate holds. `when` maps a decision to **a list** of
   alternatives (`{ condo: ['rent', 'keep'] }`), so one item can belong to several
   alternatives; multiple decisions are ANDed.
4. Apply field patches from chosen alternatives, then the chosen assumption cases, then the
   scenario's own tweaks. Two chosen alternatives patching the same field is reported as a
   **conflict**; a patch to a missing item or field is reported as **stale**. Nothing is
   silently dropped.

**Ownership.** Assets have explicit `ownedFrom` (default: as-of date) and end at their sale
date. `whileOwned` flows run on days `ownedFrom ≤ d < saleDate`. A `buy` event activates an
asset and a debt that already exist in the plan (with pre-assigned ids), so flows, overrides,
and later events can reference them.

**Day order** (dependency-aware, not by type):
1. growth and interest accrue;
2. income and unit grants (an RSU vest lands before anything can sell it);
3. transfers between accounts;
4. events: buy → sell → liquidate (proceeds are now available) → payoff;
5. expenses;
6. scheduled debt payments.

**Funding waterfall (money is conserved).** For each source in order: compute the net
fraction it yields after estimated tax and penalty, withdraw `min(available, need / netFraction)`,
and book the tax. After the listed sources, any remainder is drawn from the plan's **primary
cash account**, the only account allowed to go negative. A negative primary cash balance is
the shortfall signal and is tracked in metrics; no other account ever goes below zero.

**Sale settlement.** Price − selling costs → pays secured debts first. If the sale is
underwater, the rest of the debt is paid from primary cash. Taxable gain = price − selling
costs − cost basis − exclusion; paying off a mortgage never changes the gain.

**Equity.** Grants can withhold a % of shares for income tax (sell-to-cover); vested shares get
the vest-date price as cost basis (average-cost). Liquidations are specified in shares, gross
dollars, or % of holding, are capped at the shares held, and pay capital-gains tax (rate
overridable per event, e.g. short-term). Lot-level tracking is on the roadmap.

**Taxable income flows.** A flow can be marked as taxed at the ordinary rate (e.g. rental
income), so its net amount lands in the account.

**Lenses and verdicts.** Three balances are reported separately: *operating cash* (cash
accounts), *accessible* (cash + after-tax value of brokerage/equity), and *after-tax net
worth*. Verdicts use after-tax net worth in today's dollars and never call a difference
"negligible" if either scenario breaches the cash floor. Crossovers report both the first and
the last crossing. Stress tests vary exactly one assumption and hold every other choice
constant across scenarios.

**Changing expenses over time.** Flows support dated **amount steps** (`$2,000/mo until Sep
2027, then $500`) in addition to annual escalation.

**Quick alternatives.** "Make a decision from these items" turns a selection (e.g. everything
in the *Rental condo* group) into a *Keep* alternative and creates a paired *Sell* alternative with
a sale event, so the A/B setup takes one step.
