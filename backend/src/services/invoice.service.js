const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { calculateDocumentTotals, round2, sumAmounts } = require("../utils/money");
const { createSecureLink, revokeLinksForSubject } = require("./secure-link.service");
const { recordStageEvent } = require("./pipeline.service");
const {
  getQuotation,
  loadProvider,
  buildIdentitySnapshot,
  allocateNumber,
  formatReference,
} = require("./quotation.service");

/**
 * Invoices.
 *
 * There is no payment gateway and will not be one: payment stays between the
 * customer and the provider. This records what is owed and what has arrived.
 *
 * The payment state -- unpaid, part paid, paid, overdue -- is DERIVED from the
 * payment rows and the due date on every read. It is never stored, for two
 * reasons: a status column cannot represent a deposit followed by a balance,
 * and a stored "overdue" flag is wrong for the whole window between the due
 * date passing and whatever job was meant to set it running.
 */

const NOT_INSTALLED = "Invoices are not set up yet. Run sql/install_invoices.sql.";

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "invoices_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/**
 * The payment position, computed from the rows.
 *
 * Overdue is a real state rather than a fourth value: an invoice can be both
 * partially paid and overdue, and a provider chasing payment needs to see
 * both. So `isOverdue` sits alongside the status rather than replacing it.
 */
function paymentSummary(invoice, payments = []) {
  const total = round2(invoice.total);
  const paid = sumAmounts(payments.map((payment) => payment.amount));
  const balance = round2(total - paid);

  let status = "unpaid";
  if (paid >= total && total > 0) status = "paid";
  else if (paid > 0) status = "partially_paid";
  else if (total === 0) status = "paid";

  const isOverdue =
    status !== "paid" &&
    invoice.status === "sent" &&
    Boolean(invoice.due_date) &&
    new Date(`${invoice.due_date}T23:59:59Z`).getTime() < Date.now();

  return {
    total,
    paid,
    balance,
    paymentStatus: status,
    isOverdue,
    // What a provider reads in a list. "Overdue" wins because that is the one
    // that needs action.
    displayStatus: isOverdue
      ? "Overdue"
      : { unpaid: "Unpaid", partially_paid: "Partially Paid", paid: "Paid" }[status],
  };
}

function decorate(invoice, payments = []) {
  if (!invoice) return invoice;
  return { ...invoice, payments, ...paymentSummary(invoice, payments) };
}

function recomputeTotals(payload) {
  const totals = calculateDocumentTotals({
    lineItems: payload.lineItems || [],
    discountPercent: payload.discountPercent || 0,
    discountAmount: payload.discountAmount || 0,
    taxRatePercent: payload.taxRatePercent || 0,
    additionalCosts: payload.additionalCosts || 0,
  });
  return totals;
}

async function loadPayments(invoiceIds) {
  if (invoiceIds.length === 0) return new Map();
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .in("invoice_id", invoiceIds)
    .order("paid_on", { ascending: true });

  if (error) {
    // The invoice list is still useful without payment detail, so a failure
    // here degrades to "nothing recorded" rather than breaking the page.
    console.warn("[invoice] could not load payments:", error.message);
    return new Map();
  }

  const byInvoice = new Map();
  for (const payment of data || []) {
    if (!byInvoice.has(payment.invoice_id)) byInvoice.set(payment.invoice_id, []);
    byInvoice.get(payment.invoice_id).push(payment);
  }
  return byInvoice;
}

async function listInvoices(expertId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });

  if (error) guard(error, "Could not load your invoices.");

  const invoices = data || [];
  const payments = await loadPayments(invoices.map((invoice) => invoice.id));
  return invoices.map((invoice) => decorate(invoice, payments.get(invoice.id) || []));
}

async function getInvoice(expertId, invoiceId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that invoice.");
  if (!data) {
    throw new AppError("That invoice could not be found.", 404, { code: "invoice_not_found" });
  }

  const payments = await loadPayments([invoiceId]);
  return decorate(data, payments.get(invoiceId) || []);
}

/**
 * Converts an approved quotation into a draft invoice with no re-entry.
 *
 * Only an approved quotation: invoicing for something the customer never
 * agreed to is the one path here that could cause a real dispute.
 */
async function createFromQuotation(expertId, quotationId, payload = {}) {
  const supabase = requireSupabase();
  const quotation = await getQuotation(expertId, quotationId);

  if (quotation.status !== "approved") {
    throw new AppError(
      "Only an approved quotation can be invoiced. Ask the customer to approve it first.",
      409,
      { code: "quotation_not_approved" },
    );
  }

  // One invoice per quotation. A second would double-bill the same agreement.
  const { data: existing } = await supabase
    .from("invoices")
    .select("id, reference")
    .eq("quotation_id", quotationId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (existing) {
    throw new AppError(
      `This quotation has already been invoiced as ${existing.reference}.`,
      409,
      { code: "already_invoiced", invoiceId: existing.id },
    );
  }

  const number = await allocateNumber(expertId, "invoice");
  const deposit = round2(payload.depositAmount || 0);

  if (deposit > Number(quotation.total)) {
    throw new AppError("The deposit cannot be more than the invoice total.", 400, {
      code: "deposit_exceeds_total",
    });
  }

  const dueDate =
    payload.dueDate ||
    new Date(Date.now() + (payload.dueInDays ?? 14) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      expert_id: expertId,
      invoice_number: number,
      reference: formatReference("invoice", number),
      quotation_id: quotationId,
      quotation_reference: quotation.reference,
      customer_name: quotation.customer_name,
      customer_email: quotation.customer_email,
      customer_phone: quotation.customer_phone,
      job_name: quotation.job_name,
      customer_summary: quotation.customer_summary,
      terms: payload.terms?.trim() || quotation.terms,
      // Copied from the approved quotation, not recomputed: the figures the
      // customer agreed to are the figures that get invoiced.
      line_items: quotation.line_items,
      discount_percent: quotation.discount_percent,
      discount_amount: quotation.discount_amount,
      discount_reason: quotation.discount_reason,
      tax_rate_percent: quotation.tax_rate_percent,
      tax_label: quotation.tax_label,
      additional_costs: quotation.additional_costs,
      additional_costs_label: quotation.additional_costs_label,
      subtotal: quotation.subtotal,
      discount_total: quotation.discount_total,
      taxable_amount: quotation.taxable_amount,
      tax_amount: quotation.tax_amount,
      total: quotation.total,
      currency: quotation.currency,
      deposit_amount: deposit,
      payment_terms: payload.paymentTerms?.trim() || null,
      payment_instructions: payload.paymentInstructions?.trim() || null,
      due_date: dueDate,
      status: "draft",
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not create that invoice.");
  return decorate(data, []);
}

async function updateInvoice(expertId, invoiceId, payload) {
  const supabase = requireSupabase();
  const existing = await getInvoice(expertId, invoiceId);

  if (existing.status !== "draft") {
    throw new AppError(
      "Only a draft invoice can be changed. Cancel it and issue a new one instead.",
      409,
      { code: "invoice_locked" },
    );
  }

  const update = {
    terms: payload.terms?.trim() || null,
    payment_terms: payload.paymentTerms?.trim() || null,
    payment_instructions: payload.paymentInstructions?.trim() || null,
    due_date: payload.dueDate || existing.due_date,
    deposit_amount: round2(payload.depositAmount ?? existing.deposit_amount),
    updated_at: new Date().toISOString(),
  };

  // Line items only change if the caller actually sent some; otherwise the
  // figures copied from the approved quotation stand.
  if (payload.lineItems) {
    const totals = recomputeTotals(payload);
    Object.assign(update, {
      line_items: totals.lineItems,
      discount_percent: totals.discountPercent,
      discount_amount: totals.discountAmount,
      tax_rate_percent: totals.taxRatePercent,
      additional_costs: totals.additionalCosts,
      subtotal: totals.subtotal,
      discount_total: totals.discountTotal,
      taxable_amount: totals.taxableAmount,
      tax_amount: totals.taxAmount,
      total: totals.total,
    });
  }

  if (update.deposit_amount > Number(update.total ?? existing.total)) {
    throw new AppError("The deposit cannot be more than the invoice total.", 400, {
      code: "deposit_exceeds_total",
    });
  }

  const { data, error } = await supabase
    .from("invoices")
    .update(update)
    .eq("id", invoiceId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not save that invoice.");
  if (!data) {
    throw new AppError("That invoice could not be found.", 404, { code: "invoice_not_found" });
  }
  return decorate(data, existing.payments);
}

async function sendInvoice(expertId, invoiceId) {
  const supabase = requireSupabase();
  const invoice = await getInvoice(expertId, invoiceId);

  if (invoice.status === "cancelled") {
    throw new AppError("This invoice has been cancelled.", 409, { code: "invoice_cancelled" });
  }

  const provider = await loadProvider(expertId);

  const { data, error } = await supabase
    .from("invoices")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      business_identity: buildIdentitySnapshot(provider),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId)
    .eq("expert_id", expertId)
    .select("*")
    .single();

  if (error) guard(error, "Could not send that invoice.");

  await revokeLinksForSubject("invoice", invoiceId, "invoice_view");

  // Viewing an invoice needs no code: it discloses only what the customer was
  // already sent, and there is no action behind it to protect. A long expiry,
  // because an unpaid invoice has to stay readable until it is settled.
  const link = await createSecureLink({
    purpose: "invoice_view",
    subjectType: "invoice",
    subjectId: invoiceId,
    expertId,
    recipientEmail: data.customer_email,
    expiresInDays: 180,
    requireCode: false,
  });

  await recordStageEvent({
    subjectType: "invoice",
    subjectId: invoiceId,
    expertId,
    fromStage: invoice.status,
    toStage: "sent",
    actorType: "expert",
    source: "invoice_sent",
  });

  return { invoice: decorate(data, invoice.payments), link };
}

async function cancelInvoice(expertId, invoiceId, reason) {
  const supabase = requireSupabase();
  const invoice = await getInvoice(expertId, invoiceId);

  if (invoice.paid > 0) {
    throw new AppError(
      "This invoice has payments recorded against it and cannot be cancelled. Remove the payments first if they were entered in error.",
      409,
      { code: "invoice_has_payments" },
    );
  }

  const { data, error } = await supabase
    .from("invoices")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId)
    .eq("expert_id", expertId)
    .select("*")
    .single();

  if (error) guard(error, "Could not cancel that invoice.");
  await revokeLinksForSubject("invoice", invoiceId, "invoice_view");
  return decorate(data, []);
}

/**
 * Records a payment received.
 *
 * Overpayment is allowed and left visible rather than rejected. A customer who
 * pays $1,050 against a $1,000 invoice has done something real, and refusing
 * to record it would leave the provider with a balance that does not match
 * their bank. The balance simply goes negative, which reads as a credit.
 */
async function recordPayment(expertId, invoiceId, payload) {
  const supabase = requireSupabase();
  const invoice = await getInvoice(expertId, invoiceId);

  if (invoice.status === "cancelled") {
    throw new AppError("This invoice has been cancelled.", 409, { code: "invoice_cancelled" });
  }

  const { error } = await supabase.from("invoice_payments").insert({
    invoice_id: invoiceId,
    expert_id: expertId,
    amount: round2(payload.amount),
    paid_on: payload.paidOn || new Date().toISOString().slice(0, 10),
    method: payload.method?.trim() || null,
    reference: payload.reference?.trim() || null,
    notes: payload.notes?.trim() || null,
    recorded_by_user_id: payload.recordedByUserId || null,
  });

  if (error) guard(error, "Could not record that payment.");
  return getInvoice(expertId, invoiceId);
}

async function deletePayment(expertId, invoiceId, paymentId) {
  const supabase = requireSupabase();
  await getInvoice(expertId, invoiceId); // ownership check

  const { data, error } = await supabase
    .from("invoice_payments")
    .delete()
    .eq("id", paymentId)
    .eq("invoice_id", invoiceId)
    .eq("expert_id", expertId)
    .select("id")
    .maybeSingle();

  if (error) guard(error, "Could not remove that payment.");
  if (!data) {
    throw new AppError("That payment could not be found.", 404, { code: "payment_not_found" });
  }
  return getInvoice(expertId, invoiceId);
}

/** The customer's view of an invoice. */
function toCustomerView(invoice, payments = []) {
  const summary = paymentSummary(invoice, payments);
  return {
    reference: invoice.reference,
    quotationReference: invoice.quotation_reference,
    jobName: invoice.job_name,
    customerName: invoice.customer_name,
    customerSummary: invoice.customer_summary,
    terms: invoice.terms,
    lineItems: invoice.line_items,
    subtotal: Number(invoice.subtotal),
    discountTotal: Number(invoice.discount_total),
    discountReason: invoice.discount_reason,
    taxLabel: invoice.tax_label,
    taxRatePercent: Number(invoice.tax_rate_percent),
    taxAmount: Number(invoice.tax_amount),
    additionalCostsLabel: invoice.additional_costs_label,
    additionalCosts: Number(invoice.additional_costs),
    total: summary.total,
    depositAmount: Number(invoice.deposit_amount),
    amountPaid: summary.paid,
    balanceDue: summary.balance,
    paymentStatus: summary.displayStatus,
    isOverdue: summary.isOverdue,
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    paymentTerms: invoice.payment_terms,
    paymentInstructions: invoice.payment_instructions,
    currency: invoice.currency,
    business: invoice.business_identity || null,
    // Payment dates and amounts are shown; the provider's internal reference
    // and notes against each payment are not.
    paymentHistory: payments.map((payment) => ({
      amount: Number(payment.amount),
      paidOn: payment.paid_on,
      method: payment.method,
    })),
  };
}

async function getInvoiceForCustomer(invoiceId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) guard(error, "Could not load that invoice.");
  if (!data) {
    throw new AppError("That invoice could not be found.", 404, { code: "invoice_not_found" });
  }

  const payments = await loadPayments([invoiceId]);
  return { invoice: data, payments: payments.get(invoiceId) || [] };
}

module.exports = {
  paymentSummary,
  listInvoices,
  getInvoice,
  createFromQuotation,
  updateInvoice,
  sendInvoice,
  cancelInvoice,
  recordPayment,
  deletePayment,
  toCustomerView,
  getInvoiceForCustomer,
};
