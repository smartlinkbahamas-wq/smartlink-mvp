# SmartLink — end-to-end test

You are testing a live marketplace using only the browser. Work through
every part in order and report what you find.

**Site:** https://smartlinkbahamas.com

---

## Rules — read these first

1. **Only click.** Do not use the developer console, do not call the API
   directly, do not edit the page. If a step can't be done by clicking, that
   is a finding — report it and move on to the next part.
2. **If something fails, say so and continue** to the next numbered step.
   Don't find another route to make it pass. A failed step is the useful
   output here.
3. **Never guess at a result.** If you can't see a figure, say you couldn't
   see it. Do not assume a step passed because it looked like it should.
4. **Name everything `TEST-...`** so the records are identifiable later.
5. **Delete nothing.** Part F asks you to list what you created, not remove it.
6. **Screenshot each numbered step.**

### Email

You need two throwaway inboxes. Open **https://mail.tm** in a separate tab
and create them as you go:

- **Inbox A** — the provider's. Used for sign-up verification.
- **Inbox B** — the customer's. Used for the quotation and its approval code.

Keep both tabs open. You will come back to each.

### Password

Passwords must be **8 to 12 characters** with an uppercase letter, a
lowercase letter and a digit.

Use: **`TestPro2026x`**

> The 12-character ceiling is a known limitation of the platform, not a bug
> for you to report. If you generate a longer password it will be rejected.

---

## Part A — The customer's path (no account needed)

1. Open https://smartlinkbahamas.com and click **Find My Expert**.
2. Choose **I run a business**, then work through the questions.
3. Look for a **"Describe what you need"** free-text option. If it's there,
   type exactly:

   > *"The lights in my shop keep flickering and two sockets have stopped
   > working. I need someone this week."*

   **Assert:** it suggests an **electrical** category — not IT, not
   technology. Report whatever it actually suggests.
   - If it offers no suggestion and just shows the normal questions, that is
     an acceptable fallback. Note it and continue.
4. Finish the questions and submit the request with **Inbox A**'s address.
   - If it asks for an email verification code, fetch it from Inbox A.
5. **Assert** you reach a confirmation or results page, not an error.

---

## Part B — Provider sign-up

6. Go to **For Experts** and sign up as a provider using **Inbox A**.
7. Check Inbox A for a verification email.
   - **If no email arrives within two minutes, record that as a failure**
     and continue — it means outbound email is broken.
8. Verify, then log in.
9. Complete the provider application form. Use:
   - Business name: **TEST- Walkthrough Electrical**
   - Title: **Electrician**
   - Location: **Nassau**
   - Specialisation: **Electrical**
   - Hourly rate: **85**
10. **Assert** the Business Hub / provider dashboard loads after submitting.

---

## Part C — Quote to cash

### QuickCost

11. Open **QuickCost** (job cost / profit calculator). Enter costs totalling
    **$1,000** — for example $600 materials and $400 labour.
12. Set the target margin to **30%**.

    **Assert the suggested price is $1,428.57.**

    > If it shows **$1,300**, that is a **serious bug** — it means the system
    > is applying markup where it should apply margin, and every job would be
    > underpriced. Report it prominently.

### Quotation

13. Create a **quotation** from that estimate.
14. Add a line that is **informational, not chargeable** (for example
    "Preferred start date: Monday").

    **Assert it does not change the total.**
15. Apply a **10% discount** and a **10% tax**.

    **Assert the order is: Subtotal → Discount → Tax → Additional costs.**

    With a $1,000 subtotal you should see roughly:
    | Step | Value |
    |---|---|
    | Subtotal | 1,000.00 |
    | Less 10% discount | 900.00 |
    | Plus 10% tax | 990.00 |

    If tax is applied **before** the discount, report it — the discount must
    come first.
16. Send the quotation to **Inbox B** (the customer).

### The customer receives it — most important check

17. Open Inbox B, find the quotation email, and open the customer link
    **in a new tab**.
    - If that tab shows provider controls or a dashboard, log out and reopen
      the link, so you see what a real customer sees.

18. **Read the whole customer page, and the PDF if there is one.**

    **Assert that NONE of these appear anywhere:**
    - the cost of materials or labour
    - any hourly cost or labour rate
    - any margin or profit figure
    - the $1,000 cost total from step 11

    The customer must see only the final price.

    > This is the single most important assertion in this test. If any cost
    > or profit figure is visible to the customer, stop and report it
    > immediately with a screenshot.

19. Approve the quotation. It should require a **6-digit code** sent to
    Inbox B.

    **Assert approval is not possible without the code.** Try submitting a
    wrong code first and confirm it is rejected.

### Invoice

20. Back as the provider, convert the approved quotation to an **invoice**.
21. Record a **part payment** — for example $400 against a $990 invoice.

    **Assert** the status becomes **Partially Paid** and the outstanding
    balance is correct ($590).

---

## Part D — The job

22. Create a **job** from the approved quotation.
23. Try to move it to **Work in Progress** with the **expected completion
    date left empty**.

    **Assert it is refused.**

    > If the form simply hides or disables the button, clear the date field
    > and submit anyway if you can. The rejection must come from the server,
    > not just the screen.
24. Set an expected completion date, then move the job through
    **Work in Progress → Completed**.
25. As the customer (Inbox B), confirm completion and complete the
    satisfaction survey if offered.

---

## Part E — Admin view

> Skip this part if you don't have admin credentials. Say so in the report.

26. Sign in to the **Admin Dashboard**.
27. Find the job in reporting.
28. **Assert every rate shows its denominator** — "14 of 61", not just "23%".
29. **Assert the admin view shows the job's value but NOT the provider's
    cost or profit.**
30. Find the audit trail and **assert the job's status changes were recorded**.

---

## Part F — What you created

31. List everything you created: the provider account and its email, the
    quotation number, the invoice number, the job reference, and both inbox
    addresses.

    **Do not delete any of it.** Just list it.

---

## Your report

Give a table: **step number → pass / fail / couldn't test → what you saw.**

Then, separately:

- **Anything that broke** — what you expected, what happened, which page.
- **Anything that worked but looked wrong** — confusing wording, a figure
  that seemed off, a screen that felt unfinished.
- **Anything you couldn't reach at all**, and what stopped you.

Be blunt. This system has never been run end to end by anyone, so finding
problems is a success, not a failure.
