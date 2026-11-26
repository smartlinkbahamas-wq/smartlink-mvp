# End-to-end browser test brief

Drives the live site through a real browser, as a provider and then as a
customer. Nothing is seeded into the database: every row is created by
clicking, exactly as a real user would.

## One-time setup

```bash
claude mcp add playwright npx @playwright/mcp@latest
```

## Run

```bash
cd "<repo root>" && claude "Follow docs/E2E_BROWSER_TEST.md and run the whole test. Report a pass/fail table."
```

---

## Rules

- **Create nothing by hand.** No SQL inserts, no direct API calls to make a
  step pass. If a step cannot be completed by clicking, that is a finding,
  not an obstacle to route around.
- **Prefix every name with `TEST-`** so the rows are identifiable.
- **Never reuse a real provider's `expert_id`.** `expert_user_links` upserts
  on conflict `expert_id`, so reusing one would rebind a real account.
- **Stop and report** on the first failure of a numbered step. Do not
  "fix forward" by trying a different route to the same screen.
- Take a screenshot at each numbered step.
- Disposable inbox for all email: https://mail.tm (sign-up verification and
  the customer's 6-digit approval code both arrive there).

## Sites

| | |
|---|---|
| Customer / provider | https://smartlinkbahamas.com |
| API | https://api.smartlinkbahamas.com/api |

---

## Part A — Provider sign-up

1. Open a mail.tm inbox. Keep the tab; you will need it twice.
2. Sign up as a **provider** with that address. Password must be
   **8-12 characters** with an uppercase, a lowercase and a digit
   (`TestPro2026x` works) — the platform rejects anything longer than 12.
3. Confirm the verification email arrives, and verify.
   - *Nothing arrives?* That is a **Zoho delivery failure** — record it and
     continue; the API also returns the link in the register response.
4. Log in. Complete the provider application form.
5. Confirm the Business Hub loads.

## Part B — Quote to cash

6. **QuickCost** — build an estimate with materials and labour. Set a 30%
   margin. **Assert** $1,000 of cost prices at **$1,428.57**, not $1,300
   (margin, not markup). A wrong figure here is a serious finding.
7. **Quotation** — create one from that estimate. Add at least one
   *informational* line (e.g. "Event date") and assert it does **not**
   change the total.
8. **Assert Candy's calculation order**: Subtotal -> Discount -> Tax ->
   Additional. Apply a 10% discount and a 10% tax and check the discount is
   applied **before** tax.
9. Send the quotation to a second mail.tm address (the customer).
10. **Open the customer link in a private/incognito window.** This is the
    confidentiality check, and the most important assertion in the test:
    **assert no cost, labour rate, margin or profit figure appears anywhere**
    on the customer's page or PDF.
11. Approve using the 6-digit code from the customer inbox. Confirm the code
    is required — approval must not be possible without it.
12. Convert to an **invoice**. Record a **part payment**. Assert the status
    becomes **Partially Paid** and the balance is correct.

## Part C — Job lifecycle

13. Create a **job** from the approved quotation.
14. **Assert the server blocks "Work in Progress" without an expected
    completion date.** This must fail server-side, not just hide the button
    — try submitting with the date cleared.
15. Set the date, move through In Progress -> Completed.
16. As the customer, confirm completion and submit the survey.

## Part D — Admin

17. Sign in as admin. Confirm the job appears in reporting, and that
    **every rate shows its denominator** ("14 of 61", not "23%").
18. Confirm the audit trail recorded each job status change.
19. **Assert the admin view shows the job value but no provider cost or
    profit.**

## Part E — Teardown

20. List every `TEST-` row created. Do not delete anything yet — report the
    list and ask before removing it.

---

## Report

A table of step -> pass/fail -> evidence. For each failure: what was
expected, what happened, and the URL. Flag separately anything that worked
but looked wrong.
