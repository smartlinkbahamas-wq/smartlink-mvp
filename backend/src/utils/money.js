/**
 * Money arithmetic for quotations, invoices and cost estimates.
 *
 * One module, used by every priced feature, because the alternative is each
 * one rounding slightly differently and a customer seeing line items that do
 * not add up to the total printed underneath them.
 *
 * Two rules that are not negotiable:
 *
 * 1. Work in integer cents. 0.1 + 0.2 is 0.30000000000000004 in binary
 *    floating point, and a quotation with forty line items accumulates that
 *    error into a visible discrepancy.
 *
 * 2. Round each line before summing. If line totals are rounded only at the
 *    end, the printed lines will not add up to the printed total, and a
 *    customer who checks the arithmetic concludes the provider is padding the
 *    bill.
 */

const MAX_AMOUNT = 9999999.99; // The ceiling of numeric(10,2) in Postgres.

/** Rounds to cents, half away from zero, without binary float drift. */
function toCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  // Math.round() rounds half toward +Infinity, so -0.5 becomes -0 rather than
  // -1. Sign is handled separately to keep rounding symmetric.
  const sign = value < 0 ? -1 : 1;
  // The epsilon absorbs representations like 1.005 arriving as 1.00499999...,
  // which would otherwise round down and under-charge by a cent.
  return sign * Math.round(Math.abs(value) * 100 + Number.EPSILON * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

/** Rounds a single amount to 2dp. */
function round2(amount) {
  return fromCents(toCents(amount));
}

/**
 * A line total: quantity times unit price, rounded once.
 *
 * Quantity may be fractional (2.5 hours, 1.5 metres), so this is not simply
 * integer multiplication.
 */
function lineTotalCents(quantity, unitPrice) {
  const qty = Number(quantity);
  const unit = Number(unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
  return toCents(qty * unit);
}

function percentOfCents(cents, percent) {
  const rate = Number(percent);
  if (!Number.isFinite(rate) || rate === 0) return 0;
  return Math.round((cents * rate) / 100);
}

/**
 * Quotation and invoice totals, in the exact order the client specified:
 *
 *   Subtotal -> Discount (%) -> Tax Rate (%) -> Shipping/Additional -> Total
 *
 * Two consequences of that order, both deliberate:
 *
 * - Discount is applied BEFORE tax, so tax is charged on the discounted
 *   figure. This was stated explicitly and is also what a customer expects.
 *
 * - Additional costs fall AFTER tax, so they are NOT taxed. That follows from
 *   where they sit in the sequence. If shipping ever needs to be taxable it
 *   becomes a line item instead, which is a provider decision rather than a
 *   change here.
 *
 * `lineItems` carry quantity and unitPrice; anything flagged informational is
 * excluded from the arithmetic entirely so a florist can record an event date
 * or a flower colour without it touching the price.
 */
function calculateDocumentTotals({
  lineItems = [],
  discountPercent = 0,
  discountAmount = 0,
  taxRatePercent = 0,
  additionalCosts = 0,
} = {}) {
  const priced = lineItems.filter((item) => !item.informational);

  const lines = priced.map((item) => {
    const cents = lineTotalCents(item.quantity ?? 1, item.unitPrice ?? 0);
    return { ...item, lineTotal: fromCents(cents), lineTotalCents: cents };
  });

  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

  // A percentage and a fixed amount may both be present: the percentage is
  // taken first, then the fixed amount comes off what remains. Stated in this
  // order so two providers never disagree about what "10% and $20 off" meant.
  const percentDiscountCents = percentOfCents(subtotalCents, discountPercent);
  const fixedDiscountCents = toCents(discountAmount);
  let discountCents = percentDiscountCents + fixedDiscountCents;

  // A discount cannot exceed the subtotal. Without this a generous fixed
  // discount produces a negative taxable base and then negative tax, which
  // reads as the provider owing the customer money.
  if (discountCents > subtotalCents) discountCents = subtotalCents;
  if (discountCents < 0) discountCents = 0;

  const taxableCents = subtotalCents - discountCents;
  const taxCents = percentOfCents(taxableCents, taxRatePercent);
  const additionalCents = toCents(additionalCosts);
  const totalCents = taxableCents + taxCents + additionalCents;

  return {
    lineItems: lines.map(({ lineTotalCents: _ignored, ...line }) => line),
    subtotal: fromCents(subtotalCents),
    discountPercent: Number(discountPercent) || 0,
    discountAmount: fromCents(fixedDiscountCents),
    discountTotal: fromCents(discountCents),
    taxableAmount: fromCents(taxableCents),
    taxRatePercent: Number(taxRatePercent) || 0,
    taxAmount: fromCents(taxCents),
    additionalCosts: fromCents(additionalCents),
    total: fromCents(totalCents),
  };
}

/**
 * Selling price from cost and a target MARGIN.
 *
 *   price = cost / (1 - margin)
 *
 * Margin, not markup. $1,000 at 30% margin is $1,428.57, not $1,300 -- the
 * $1,300 figure is a 30% markup, which yields a 23.08% margin. Providers
 * routinely mean one and compute the other, so both figures are returned and
 * the UI shows them side by side rather than making anyone guess.
 */
function priceFromCostAndMargin(cost, marginPercent) {
  const costCents = toCents(cost);
  const margin = Number(marginPercent);

  if (!Number.isFinite(margin) || margin <= 0) {
    return { price: fromCents(costCents), marginPercent: 0, markupPercent: 0 };
  }

  // At 100% margin the formula divides by zero: an infinite price for any
  // non-zero cost. Capped rather than rejected, because a provider dragging a
  // slider to the end should see a very large number, not an error.
  const safeMargin = Math.min(margin, 99);
  const priceCents = Math.round(costCents / (1 - safeMargin / 100));

  return {
    price: fromCents(Math.min(priceCents, toCents(MAX_AMOUNT))),
    marginPercent: round2(safeMargin),
    markupPercent: costCents > 0 ? round2(((priceCents - costCents) / costCents) * 100) : 0,
  };
}

/**
 * The reverse: what margin and markup a chosen price actually delivers.
 *
 * A price below cost is allowed and reported as a negative margin. Providers
 * do discount below cost deliberately -- to win a first job, or to keep a
 * regular customer -- and refusing to compute it would mean refusing to show
 * them the loss.
 */
function marginFromCostAndPrice(cost, price) {
  const costCents = toCents(cost);
  const priceCents = toCents(price);

  if (priceCents === 0) {
    return { profit: fromCents(-costCents), marginPercent: 0, markupPercent: 0, belowCost: costCents > 0 };
  }

  const profitCents = priceCents - costCents;

  return {
    profit: fromCents(profitCents),
    marginPercent: round2((profitCents / priceCents) * 100),
    markupPercent: costCents > 0 ? round2((profitCents / costCents) * 100) : 0,
    belowCost: profitCents < 0,
  };
}

/** Sums amounts in cents so a list of payments reconciles exactly. */
function sumAmounts(amounts = []) {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0));
}

/**
 * For customer-facing documents. Grouped thousands, because "$1428.57" on an
 * invoice reads as a mistake next to "$1,428.57".
 *
 * The sign sits outside the symbol -- "-$200.00", not "$-200.00".
 */
function formatAmount(amount, currency = "USD") {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const value = round2(amount);
  const sign = value < 0 ? "-" : "";
  const grouped = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${symbol}${grouped}`;
}

module.exports = {
  MAX_AMOUNT,
  toCents,
  fromCents,
  round2,
  lineTotalCents,
  calculateDocumentTotals,
  priceFromCostAndMargin,
  marginFromCostAndPrice,
  sumAmounts,
  formatAmount,
};
