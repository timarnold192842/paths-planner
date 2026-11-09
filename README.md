# Paths

Compare your financial futures. Paths models your accounts, debts, and cash flows day by day for
up to 60 years, then answers A/B questions like:

* *Should we sell the rental, or keep it?* — near-term cash cushion vs long-term wealth.
* *Should I pay this loan off early?* — can I sustain it without dipping below my cash floor, and does it matter in 30 years?
* *Should I sell company stock as it vests?* — and does the answer hold in a bear market?

Live: https://timarnold192842.github.io/paths-planner/ (opens with a fictional demo household)

## How it works

* **Plan** — every account, debt, cash flow, and event lives here exactly once.
* **Decisions** — things you control, each with alternatives. Plan items can belong to an
  alternative ("the rent only exists if we keep the condo"); alternatives can also change values.
* **Assumptions** — things you don't control (stock price Bear/Mid/Bull, appreciation, inflation).
* **Scenarios** — a saved set of choices. They never copy the plan, so plan edits apply everywhere.
* **Compare** — verdict, difference chart, cash-floor check, scorecard, "what's different", and a
  stress test across an assumption's cases.

Borrowing is first-class: a home-equity line, a 0% intro card, a balance transfer or a loan is one
debt with terms (fees, rate changes, payment rules, payoff date, credit limit) instead of a string
of hand-built transactions; credit lines can act as a safety net when cash runs low.

Every result explains itself: the change in net worth is broken down into income, spending,
taxes, interest, fees, and growth — per year, and as the difference between two scenarios.
Quick what-ifs let you try a change without saving anything, and check-ins keep the plan current
while tracking actual vs. expected.

Also: funding waterfalls ("pay college from the 529 first, then cash"), account tax treatments
(401k, Roth, HSA, 529, brokerage, company stock, property) with back-of-the-envelope taxes and an
after-tax net-worth lens, paychecks with payroll taxes, withholding and deductions (Social
Security stops at the wage base, a 401(k) at its limit) trued up against the federal brackets
each April, dated amount changes, flows that stop when an asset is sold, and an importer for the
old Forecast app. The Plan lists can be reordered by dragging (mouse, touch or ↑/↓ on the grip),
cash flows can be dragged between groups, and groups fold. The Overview chart can show any
account, loan, account-type total or plan total (“+ Add line…”), and its range can be nudged by
±1 week, month or year.

See [docs/DESIGN.md](docs/DESIGN.md) for the model and engine rules.

## Your data

Plans are saved in your browser (local storage). Use **Settings → Export backup** to move a plan
between devices; server sync is the next milestone. This repository contains no personal data.

## Development

No build step — native ES modules with vendored [Preact](https://preactjs.com),
[htm](https://github.com/developit/htm), and [uPlot](https://github.com/leeoniya/uPlot) in `vendor/`.

```sh
python3 -m http.server 8000      # then open http://localhost:8000
node --test tests/*.test.mjs     # engine tests (Node 20+)
```

`tests/parity.test.mjs` checks the engine against the old Forecast app when `../budget-pages`
exists next to this repo (or `LEGACY_FORECAST_DIR` points at it); otherwise it is skipped.

GitHub Pages serves the repository root from `main`.
