const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { calculateDocumentTotals, round2 } = require("../utils/money");
const {
  createSecureLink,
  revokeLinksForSubject,
} = require("./secure-link.service");
const { recordStageEvent } = require("./pipeline.service");

/**
 * Quotations.
 *
 * The calculation order is fixed and was specified exactly:
 *   Subtotal -> Discount (%) -> Tax (%) -> Shipping/Additional -> Total
 * All of it happens in money.js. The client never sends a total, so no total
 * can be forged.
 *
 * Two rules shape most of what follows:
 *
 * - An approved quotation is immutable. The price, scope and terms the
 *   customer agreed to cannot be edited afterwards; a change means a new
 *   quotation. Without that, "approved" means nothing.
 *
 * - Only a VAT-registered provider may charge VAT, and the registration number
 *   must appear on the document. Checked against the provider record at send
 *   time, not taken from the request.
 */

const NOT_INSTALLED = "Quotations are not set up yet. Run sql/install_quotations.sql.";

const EDITABLE_STATUSES = ["draft", "sent", "changes_requested", "declined"];

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "quotations_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/**
 * Expiry is derived, never stored.
 *
 * A stored 'expired' status would be wrong for the whole window between the
 * validity lapsing and whatever job was meant to flip it running, and there is
 * no scheduler yet. Computing it means it is always right.
 */
function isExpired(quotation) {
  if (!quotation?.valid_until) return false;
  if (["approved", "declined", "superseded"].includes(quotation.status)) return false;
  return new Date(quotation.valid_until).getTime() < Date.now();
}

function effectiveStatus(quotation) {
  return isExpired(quotation) ? "expired" : quotation.status;
}

/** Adds the derived fields every caller needs, so none of them recompute it. */
function decorate(quotation) {
  if (!quotation) return quotation;
  return {
    ...quotation,
    effective_status: effectiveStatus(quotation),
    is_expired: isExpired(quotation),
    is_locked: quotation.status === "approved" || quotation.status === "superseded",
  };
}

/** Normalises line items and recomputes every money field from inputs alone. */
function buildTotals(payload) {
  const lineItems = (payload.lineItems || []).map((item) => ({
    label: String(item.label || "").trim(),
    description: item.description?.trim() || null,
    quantity: item.informational ? null : Number(item.quantity ?? 1),
    unitPrice: item.informational ? null : round2(item.unitPrice ?? 0),
    unit: item.unit?.trim() || null,
    // An informational line records something about the job without pricing
    // it: an event date, flower colours, a site note.
    informational: Boolean(item.informational),
    value: item.informational ? (item.value?.trim() || null) : null,
  }));

  // Tagged with their position before costing, because
  // calculateDocumentTotals drops informational lines from its output and the
  // priced ones have to be matched back afterwards. Matching on label would
  // break the moment a quotation carries two lines called "Labour", which is
  // entirely normal.
  const indexed = lineItems.map((item, index) => ({ ...item, _idx: index }));

  const totals = calculateDocumentTotals({
    lineItems: indexed,
    discountPercent: payload.discountPercent || 0,
    discountAmount: payload.discountAmount || 0,
    taxRatePercent: payload.taxRatePercent || 0,
    additionalCosts: payload.additionalCosts || 0,
  });

  const pricedByIndex = new Map(totals.lineItems.map((item) => [item._idx, item]));
  const merged = indexed.map((item) => {
    const priced = item.informational ? null : pricedByIndex.get(item._idx);
    const { _idx, ...rest } = priced ? { ...item, ...priced } : item;
    return rest;
  });

  return { ...totals, lineItems: merged };
}

function toRow(payload) {
  const totals = buildTotals(payload);

  return {
    customer_name: String(payload.customerName).trim(),
    customer_email: String(payload.customerEmail).trim().toLowerCase(),
    customer_phone: payload.customerPhone?.trim() || null,
    job_name: String(payload.jobName).trim(),
    customer_summary: payload.customerSummary?.trim() || null,
    terms: payload.terms?.trim() || null,
    line_items: totals.lineItems,
    discount_percent: totals.discountPercent,
    discount_amount: totals.discountAmount,
    discount_reason: payload.discountReason?.trim() || null,
    tax_rate_percent: totals.taxRatePercent,
    tax_label: payload.taxLabel?.trim() || "Tax",
    additional_costs: totals.additionalCosts,
    additional_costs_label:
      payload.additionalCostsLabel?.trim() || "Shipping / additional costs",
    subtotal: totals.subtotal,
    discount_total: totals.discountTotal,
    taxable_amount: totals.taxableAmount,
    tax_amount: totals.taxAmount,
    total: totals.total,
    validity_days: payload.validityDays || 30,
    source_estimate_id: payload.sourceEstimateId || null,
    lead_id: payload.leadId || null,
    introduction_request_id: payload.introductionRequestId || null,
  };
}

async function loadProvider(expertId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("experts")
    .select(
      "expert_id, name, business_name, business_address, business_phone, business_email, website_url, logo_url, vat_registered, vat_number",
    )
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) throw new AppError("Could not load your business details.", 500, error.message);
  if (!data) {
    throw new AppError("No provider profile is linked to this account.", 403, {
      code: "expert_profile_not_linked",
    });
  }
  return data;
}

/**
 * The identity snapshot written onto a sent quotation.
 *
 * Taken once, at send time. A provider who later changes their address or
 * deregisters for VAT must not retroactively alter a document the customer
 * has already received or approved.
 */
function buildIdentitySnapshot(provider) {
  return {
    business_name: provider.business_name || provider.name,
    address: provider.business_address || null,
    phone: provider.business_phone || null,
    email: provider.business_email || null,
    website: provider.website_url || null,
    logo_url: provider.logo_url || null,
    vat_registered: Boolean(provider.vat_registered),
    vat_number: provider.vat_registered ? provider.vat_number : null,
    captured_at: new Date().toISOString(),
  };
}

async function allocateNumber(expertId, docType) {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc("next_document_number", {
    p_expert_id: expertId,
    p_doc_type: docType,
  });

  if (error) {
    if (tableIsMissing(error) || /function .* does not exist/i.test(error.message || "")) {
      throw new AppError(
        "Document numbering is not set up yet. Run sql/install_business_foundations.sql.",
        503,
        { code: "numbering_not_installed" },
      );
    }
    throw new AppError("Could not allocate a document number.", 500, error.message);
  }
  return data;
}

function formatReference(docType, number) {
  const prefix = { quotation: "QUO", invoice: "INV", job: "JOB" }[docType] || "DOC";
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

// --- Provider operations ---------------------------------------------------

async function listQuotations(expertId, { status = null } = {}) {
  const supabase = requireSupabase();
  let query = supabase
    .from("quotations")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) guard(error, "Could not load your quotations.");
  return (data || []).map(decorate);
}

async function getQuotation(expertId, quotationId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quotations")
    .select("*")
    .eq("id", quotationId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that quotation.");
  if (!data) {
    throw new AppError("That quotation could not be found.", 404, { code: "quotation_not_found" });
  }
  return decorate(data);
}

async function createQuotation(expertId, payload) {
  const supabase = requireSupabase();
  const provider = await loadProvider(expertId);

  // Checked against the provider record, not the request: a provider who is
  // not registered cannot put a tax line on a customer document.
  if (Number(payload.taxRatePercent) > 0 && !provider.vat_registered) {
    throw new AppError(
      "Only a VAT-registered business can apply tax. Add your VAT registration in your profile first.",
      400,
      { code: "vat_not_registered" },
    );
  }

  const number = await allocateNumber(expertId, "quotation");

  const { data, error } = await supabase
    .from("quotations")
    .insert({
      ...toRow(payload),
      expert_id: expertId,
      quotation_number: number,
      reference: formatReference("quotation", number),
      status: "draft",
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not create that quotation.");

  // Fills the provider's customer list through ordinary work, rather than
  // asking them to maintain it separately. Cannot throw, so a failure here
  // leaves the quotation intact and merely unlinked.
  const { findOrCreateForDocument } = require("./customer.service");
  const customerId = await findOrCreateForDocument(expertId, {
    email: data.customer_email,
    fullName: data.customer_name,
    phone: data.customer_phone,
    leadId: data.lead_id,
    introductionRequestId: data.introduction_request_id,
  });

  if (customerId) {
    const { data: linked } = await supabase
      .from("quotations")
      .update({ customer_id: customerId })
      .eq("id", data.id)
      .eq("expert_id", expertId)
      .select("*")
      .maybeSingle();
    if (linked) return decorate(linked);
  }

  return decorate(data);
}

async function updateQuotation(expertId, quotationId, payload) {
  const supabase = requireSupabase();
  const existing = await getQuotation(expertId, quotationId);

  // The locking rule. Once a customer has agreed a price, changing it behind
  // their approval is not an edit -- it is a different quotation.
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new AppError(
      existing.status === "approved"
        ? "This quotation has been approved and can no longer be changed. Create a revised quotation instead."
        : "This quotation can no longer be changed.",
      409,
      { code: "quotation_locked" },
    );
  }

  const provider = await loadProvider(expertId);
  if (Number(payload.taxRatePercent) > 0 && !provider.vat_registered) {
    throw new AppError(
      "Only a VAT-registered business can apply tax. Add your VAT registration in your profile first.",
      400,
      { code: "vat_not_registered" },
    );
  }

  const { data, error } = await supabase
    .from("quotations")
    .update({ ...toRow(payload), updated_at: new Date().toISOString() })
    .eq("id", quotationId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not save that quotation.");
  if (!data) {
    throw new AppError("That quotation could not be found.", 404, { code: "quotation_not_found" });
  }

  // Editing a quotation the customer has already been sent invalidates the
  // link they are holding: it would otherwise show them the old figures while
  // approving the new ones.
  if (existing.status === "sent") {
    await revokeLinksForSubject("quotation", quotationId, "quotation_approval");
  }

  return decorate(data);
}

/**
 * Sends a quotation: snapshots identity, sets the validity window, records an
 * immutable version, and mints the customer's approval link and code.
 *
 * The plaintext token and code are returned once for the email and are never
 * readable again.
 */
async function sendQuotation(expertId, quotationId) {
  const supabase = requireSupabase();
  const quotation = await getQuotation(expertId, quotationId);

  if (quotation.status === "approved") {
    throw new AppError("This quotation has already been approved.", 409, {
      code: "quotation_locked",
    });
  }

  const provider = await loadProvider(expertId);
  const identity = buildIdentitySnapshot(provider);

  if (Number(quotation.tax_rate_percent) > 0 && !identity.vat_registered) {
    throw new AppError(
      "Only a VAT-registered business can apply tax. Remove the tax or add your VAT registration.",
      400,
      { code: "vat_not_registered" },
    );
  }

  const validUntil = new Date(
    Date.now() + Number(quotation.validity_days) * 24 * 60 * 60 * 1000,
  ).toISOString();

  // A re-send counts as a new version: the customer may be looking at
  // different figures from last time.
  const nextVersion = quotation.sent_at ? Number(quotation.version) + 1 : Number(quotation.version);

  const { data, error } = await supabase
    .from("quotations")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      valid_until: validUntil,
      business_identity: identity,
      version: nextVersion,
      // A re-send opens a fresh validity window, so the expiry reminder for
      // the previous one must not suppress the next.
      expiry_reminder_sent_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", quotationId)
    .eq("expert_id", expertId)
    .select("*")
    .single();

  if (error) guard(error, "Could not send that quotation.");

  // Immutable record of exactly what was sent.
  const { error: versionError } = await supabase.from("quotation_versions").insert({
    quotation_id: quotationId,
    version: nextVersion,
    snapshot: data,
  });
  if (versionError && versionError.code !== "23505") {
    console.warn("[quotation] could not record version:", versionError.message);
  }

  // Any earlier link must stop working, or a customer holding two emails could
  // approve the superseded figures.
  await revokeLinksForSubject("quotation", quotationId, "quotation_approval");

  const link = await createSecureLink({
    purpose: "quotation_approval",
    subjectType: "quotation",
    subjectId: quotationId,
    expertId,
    recipientEmail: data.customer_email,
    expiresAt: validUntil,
    requireCode: true,
  });

  await recordStageEvent({
    subjectType: "quotation",
    subjectId: quotationId,
    expertId,
    leadId: data.lead_id,
    fromStage: quotation.status,
    toStage: "sent",
    actorType: "expert",
    source: "quotation_sent",
  });

  return { quotation: decorate(data), link };
}

/**
 * Extends the validity window.
 *
 * Safe by construction rather than by comparison: extension only changes
 * valid_until, and any edit to the figures goes through updateQuotation, which
 * revokes the customer's link. So an extended quotation is necessarily the
 * same price, scope and terms the customer was already sent.
 */
async function extendValidity(expertId, quotationId, additionalDays) {
  const supabase = requireSupabase();
  const quotation = await getQuotation(expertId, quotationId);

  if (quotation.status !== "sent") {
    throw new AppError(
      "Only a quotation that has been sent and not yet answered can be extended.",
      409,
      { code: "quotation_not_extendable" },
    );
  }

  // Extends from whichever is later: an expired quotation extended by 7 days
  // should be valid for 7 more days from now, not 7 days from a date already
  // in the past.
  const base = Math.max(new Date(quotation.valid_until || Date.now()).getTime(), Date.now());
  const validUntil = new Date(base + Number(additionalDays) * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("quotations")
    .update({
      valid_until: validUntil,
      // Extending moves the deadline, so the provider should be reminded
      // again as the new one approaches.
      expiry_reminder_sent_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", quotationId)
    .eq("expert_id", expertId)
    .select("*")
    .single();

  if (error) guard(error, "Could not extend that quotation.");
  return decorate(data);
}

/**
 * Creates a revised quotation from an existing one.
 *
 * The route for an approved or expired quotation that needs changing: the
 * original is marked superseded and kept, and the revision gets its own number
 * so there is no ambiguity about which document a customer agreed to.
 */
async function reviseQuotation(expertId, quotationId) {
  const supabase = requireSupabase();
  const original = await getQuotation(expertId, quotationId);

  const number = await allocateNumber(expertId, "quotation");

  const { data, error } = await supabase
    .from("quotations")
    .insert({
      expert_id: expertId,
      quotation_number: number,
      reference: formatReference("quotation", number),
      supersedes_id: original.id,
      status: "draft",
      version: 1,
      customer_name: original.customer_name,
      customer_email: original.customer_email,
      customer_phone: original.customer_phone,
      job_name: original.job_name,
      customer_summary: original.customer_summary,
      terms: original.terms,
      line_items: original.line_items,
      discount_percent: original.discount_percent,
      discount_amount: original.discount_amount,
      discount_reason: original.discount_reason,
      tax_rate_percent: original.tax_rate_percent,
      tax_label: original.tax_label,
      additional_costs: original.additional_costs,
      additional_costs_label: original.additional_costs_label,
      subtotal: original.subtotal,
      discount_total: original.discount_total,
      taxable_amount: original.taxable_amount,
      tax_amount: original.tax_amount,
      total: original.total,
      currency: original.currency,
      validity_days: original.validity_days,
      lead_id: original.lead_id,
      introduction_request_id: original.introduction_request_id,
      source_estimate_id: original.source_estimate_id,
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not create a revised quotation.");

  await supabase
    .from("quotations")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("id", quotationId)
    .eq("expert_id", expertId);

  await revokeLinksForSubject("quotation", quotationId, "quotation_approval");

  return decorate(data);
}

async function deleteQuotation(expertId, quotationId) {
  const supabase = requireSupabase();
  const quotation = await getQuotation(expertId, quotationId);

  // Only a draft may be deleted. Once a customer has seen it, the document is
  // part of a record the provider may need later.
  if (quotation.status !== "draft") {
    throw new AppError(
      "Only a draft quotation can be deleted. Create a revised quotation instead.",
      409,
      { code: "quotation_not_deletable" },
    );
  }

  const { error } = await supabase
    .from("quotations")
    .delete()
    .eq("id", quotationId)
    .eq("expert_id", expertId);

  if (error) guard(error, "Could not delete that quotation.");
  return { id: quotationId };
}

async function listVersions(expertId, quotationId) {
  await getQuotation(expertId, quotationId); // ownership check
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quotation_versions")
    .select("id, version, created_at, snapshot")
    .eq("quotation_id", quotationId)
    .order("version", { ascending: false });

  if (error) guard(error, "Could not load the version history.");
  return data || [];
}

// --- Customer operations ---------------------------------------------------

/** The customer's view. Only what belongs on the document. */
function toCustomerView(quotation) {
  return {
    reference: quotation.reference,
    version: quotation.version,
    jobName: quotation.job_name,
    customerSummary: quotation.customer_summary,
    customerName: quotation.customer_name,
    terms: quotation.terms,
    lineItems: quotation.line_items,
    subtotal: Number(quotation.subtotal),
    discountPercent: Number(quotation.discount_percent),
    discountTotal: Number(quotation.discount_total),
    discountReason: quotation.discount_reason,
    taxLabel: quotation.tax_label,
    taxRatePercent: Number(quotation.tax_rate_percent),
    taxAmount: Number(quotation.tax_amount),
    additionalCostsLabel: quotation.additional_costs_label,
    additionalCosts: Number(quotation.additional_costs),
    total: Number(quotation.total),
    currency: quotation.currency,
    validUntil: quotation.valid_until,
    status: effectiveStatus(quotation),
    business: quotation.business_identity || null,
    // Deliberately absent: expert_id, lead_id, source_estimate_id and every
    // internal timestamp. Nothing about cost or margin exists on this table at
    // all, so there is nothing to strip.
  };
}

async function getQuotationForCustomer(quotationId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quotations")
    .select("*")
    .eq("id", quotationId)
    .maybeSingle();

  if (error) guard(error, "Could not load that quotation.");
  if (!data) {
    throw new AppError("That quotation could not be found.", 404, { code: "quotation_not_found" });
  }
  return data;
}

/**
 * Records the customer's decision.
 *
 * Called only after the secure link and the emailed code have both been
 * verified, and the link is consumed by the caller, so a decision cannot be
 * submitted twice.
 */
async function recordCustomerDecision(quotationId, { decision, message, acceptedTerms, method }) {
  const supabase = requireSupabase();
  const quotation = await getQuotationForCustomer(quotationId);

  if (quotation.status === "approved") {
    throw new AppError("This quotation has already been approved.", 409, { code: "already_approved" });
  }
  if (isExpired(quotation)) {
    throw new AppError(
      "This quotation has expired. Ask the provider to send an updated one.",
      410,
      { code: "quotation_expired" },
    );
  }

  const statusByDecision = {
    approve: "approved",
    decline: "declined",
    request_changes: "changes_requested",
  };
  const nextStatus = statusByDecision[decision];
  if (!nextStatus) {
    throw new AppError("Choose approve, decline, or request changes.", 400, {
      code: "invalid_decision",
    });
  }

  const update = {
    status: nextStatus,
    responded_at: new Date().toISOString(),
    customer_message: message?.trim() || null,
    updated_at: new Date().toISOString(),
  };

  if (nextStatus === "approved") {
    update.approved_at = new Date().toISOString();
    update.approval_method = method || "email_code";
    update.approved_terms = Boolean(acceptedTerms);
  }

  const { data, error } = await supabase
    .from("quotations")
    .update(update)
    .eq("id", quotationId)
    .select("*")
    .single();

  if (error) guard(error, "Could not record that decision.");

  await recordStageEvent({
    subjectType: "quotation",
    subjectId: quotationId,
    expertId: data.expert_id,
    leadId: data.lead_id,
    fromStage: quotation.status,
    toStage: nextStatus,
    actorType: "client",
    source: "customer_decision",
    notes: message ? "Customer left a message." : null,
  });

  return decorate(data);
}

module.exports = {
  isExpired,
  effectiveStatus,
  decorate,
  buildTotals,
  formatReference,
  allocateNumber,
  loadProvider,
  buildIdentitySnapshot,
  listQuotations,
  getQuotation,
  createQuotation,
  updateQuotation,
  sendQuotation,
  extendValidity,
  reviseQuotation,
  deleteQuotation,
  listVersions,
  getQuotationForCustomer,
  toCustomerView,
  recordCustomerDecision,
};
