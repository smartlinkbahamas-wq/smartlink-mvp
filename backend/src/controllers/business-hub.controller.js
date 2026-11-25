const { ZodError } = require("zod");

const { AppError } = require("../utils/app-error");
const { resolveExpertIdForUser } = require("../utils/expert-identity");
const {
  quickcostSchema,
  quickcostActualsSchema,
  quotationBaseSchema,
  extendValiditySchema,
  invoiceFromQuotationSchema,
  invoiceUpdateSchema,
  paymentSchema,
  manualJobSchema,
  jobFromQuotationSchema,
  jobStatusSchema,
  jobDateRevisionSchema,
} = require("../validators/business.validator");

const quickcost = require("../services/quickcost.service");
const quotations = require("../services/quotation.service");
const invoices = require("../services/invoice.service");
const jobs = require("../services/job.service");
const { renderQuotationPdf, renderInvoicePdf } = require("../services/document-pdf.service");
const { sendQuotationEmail, sendInvoiceEmail } = require("../services/mail.service");
const { env } = require("../config/env");

/**
 * Provider-facing endpoints for the Business Hub: cost estimates, quotations,
 * invoices and jobs.
 *
 * Every handler resolves the provider from the session and passes that id into
 * the service. No handler takes an expert id from the request body -- that
 * would be an authorisation hole dressed as a parameter.
 */

function parse(schema, payload, message) {
  try {
    return schema.parse(payload || {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, { code: "validation_error", fields: error.flatten() });
    }
    throw error;
  }
}

function customerLinkUrl(path, token) {
  const base = (env.FRONTEND_BASE_URL || env.CORS_ORIGIN || "").split(",")[0].trim();
  // The token goes in the URL FRAGMENT, not the query string.
  //
  // morgan("combined") logs full request URLs, so "?t=TOKEN" would write a
  // working approval token into the server access log for every page load.
  // A fragment is never sent to any server and never appears in a Referer
  // header; the page reads it client-side and passes it as a request header.
  const suffix = `${path}#t=${token}`;
  // Relative when no base is configured, so the caller still gets a usable
  // path rather than a URL pointing at "undefined".
  return base ? `${base.replace(/\/$/, "")}${suffix}` : suffix;
}

// --- QuickCost -------------------------------------------------------------

async function listEstimates(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: { estimates: await quickcost.listEstimates(expertId) } });
}

async function getEstimate(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: await quickcost.getEstimate(expertId, req.params.id) });
}

async function createEstimate(req, res) {
  const payload = parse(quickcostSchema, req.body, "Check the cost details and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const estimate = await quickcost.createEstimate(expertId, payload);
  return res.status(201).json({ success: true, message: "Cost estimate saved.", data: estimate });
}

async function updateEstimate(req, res) {
  const payload = parse(quickcostSchema, req.body, "Check the cost details and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const estimate = await quickcost.updateEstimate(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Cost estimate saved.", data: estimate });
}

async function deleteEstimate(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({
    success: true,
    message: "Cost estimate removed.",
    data: await quickcost.deleteEstimate(expertId, req.params.id),
  });
}

async function recordEstimateActuals(req, res) {
  const payload = parse(quickcostActualsSchema, req.body, "Check those figures and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const estimate = await quickcost.recordActuals(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Figures recorded.", data: estimate });
}

/**
 * Hands a cost estimate over to a quotation.
 *
 * Returns only what getQuoteBasis allows through: job name, customer summary
 * and final price. Cost, labour, overhead and margin never cross this line.
 */
async function getEstimateQuoteBasis(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const estimate = await quickcost.getEstimate(expertId, req.params.id);
  return res.json({ success: true, data: quickcost.getQuoteBasis(estimate) });
}

// --- Quotations ------------------------------------------------------------

async function listQuotations(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const items = await quotations.listQuotations(expertId, {
    status: req.query?.status ? String(req.query.status) : null,
  });
  return res.json({ success: true, data: { quotations: items } });
}

async function getQuotation(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: await quotations.getQuotation(expertId, req.params.id) });
}

async function createQuotation(req, res) {
  const payload = parse(quotationBaseSchema, req.body, "Check the quotation and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const quotation = await quotations.createQuotation(expertId, payload);
  return res.status(201).json({ success: true, message: "Quotation created.", data: quotation });
}

async function updateQuotation(req, res) {
  const payload = parse(quotationBaseSchema, req.body, "Check the quotation and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const quotation = await quotations.updateQuotation(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Quotation saved.", data: quotation });
}

/**
 * Sends the quotation to the customer.
 *
 * The link and code exist in plaintext only for the duration of this request.
 * If the email fails the provider is told, and is given the link so they can
 * pass it on another way rather than being left with a sent quotation the
 * customer never received.
 */
async function sendQuotation(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const { quotation, link } = await quotations.sendQuotation(expertId, req.params.id);

  const url = customerLinkUrl("/quotation", link.token);
  const delivery = await sendQuotationEmail({
    to: quotation.customer_email,
    customerName: quotation.customer_name,
    businessName: quotation.business_identity?.business_name,
    reference: quotation.reference,
    jobName: quotation.job_name,
    total: Number(quotation.total),
    currency: quotation.currency,
    validUntil: quotation.valid_until,
    url,
    code: link.code,
  });

  return res.json({
    success: true,
    message: delivery.sent
      ? `Quotation sent to ${quotation.customer_email}.`
      : "Quotation marked as sent, but the email could not be delivered. Share the link below instead.",
    data: {
      quotation,
      customerUrl: url,
      delivered: delivery.sent,
      // The verification code is NOT returned. It goes to the customer's
      // address or nowhere; handing it back here would defeat the point of
      // proving they control that address.
    },
  });
}

async function extendQuotationValidity(req, res) {
  const payload = parse(extendValiditySchema, req.body, "Choose how long to extend by.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const quotation = await quotations.extendValidity(expertId, req.params.id, payload.additionalDays);
  return res.json({ success: true, message: "Validity extended.", data: quotation });
}

async function reviseQuotation(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const quotation = await quotations.reviseQuotation(expertId, req.params.id);
  return res
    .status(201)
    .json({ success: true, message: "Revised quotation created as a draft.", data: quotation });
}

async function deleteQuotation(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({
    success: true,
    message: "Draft deleted.",
    data: await quotations.deleteQuotation(expertId, req.params.id),
  });
}

async function listQuotationVersions(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const versions = await quotations.listVersions(expertId, req.params.id);
  return res.json({ success: true, data: { versions } });
}

async function downloadQuotationPdf(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const quotation = await quotations.getQuotation(expertId, req.params.id);

  // A draft has no identity snapshot yet, so the live profile is used for a
  // preview. A sent quotation always prints its snapshot.
  if (!quotation.business_identity) {
    const provider = await quotations.loadProvider(expertId);
    quotation.business_identity = quotations.buildIdentitySnapshot(provider);
  }

  const pdf = await renderQuotationPdf(quotation);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${quotation.reference}.pdf"`);
  return res.send(pdf);
}

// --- Invoices --------------------------------------------------------------

async function listInvoices(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: { invoices: await invoices.listInvoices(expertId) } });
}

async function getInvoice(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: await invoices.getInvoice(expertId, req.params.id) });
}

async function createInvoiceFromQuotation(req, res) {
  const payload = parse(invoiceFromQuotationSchema, req.body, "Check the invoice details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.createFromQuotation(expertId, req.params.quotationId, payload);
  return res.status(201).json({ success: true, message: "Draft invoice created.", data: invoice });
}

async function updateInvoice(req, res) {
  const payload = parse(invoiceUpdateSchema, req.body, "Check the invoice details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.updateInvoice(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Invoice saved.", data: invoice });
}

async function sendInvoice(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const { invoice, link } = await invoices.sendInvoice(expertId, req.params.id);

  const url = customerLinkUrl("/invoice", link.token);
  const delivery = await sendInvoiceEmail({
    to: invoice.customer_email,
    customerName: invoice.customer_name,
    businessName: invoice.business_identity?.business_name,
    reference: invoice.reference,
    jobName: invoice.job_name,
    balanceDue: invoice.balance,
    currency: invoice.currency,
    dueDate: invoice.due_date,
    url,
  });

  return res.json({
    success: true,
    message: delivery.sent
      ? `Invoice sent to ${invoice.customer_email}.`
      : "Invoice marked as sent, but the email could not be delivered. Share the link below instead.",
    data: { invoice, customerUrl: url, delivered: delivery.sent },
  });
}

async function cancelInvoice(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.cancelInvoice(expertId, req.params.id, req.body?.reason);
  return res.json({ success: true, message: "Invoice cancelled.", data: invoice });
}

async function recordPayment(req, res) {
  const payload = parse(paymentSchema, req.body, "Check the payment details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.recordPayment(expertId, req.params.id, {
    ...payload,
    recordedByUserId: req.user?.userId || null,
  });
  return res.status(201).json({ success: true, message: "Payment recorded.", data: invoice });
}

async function deletePayment(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.deletePayment(expertId, req.params.id, req.params.paymentId);
  return res.json({ success: true, message: "Payment removed.", data: invoice });
}

async function downloadInvoicePdf(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const invoice = await invoices.getInvoice(expertId, req.params.id);

  if (!invoice.business_identity) {
    const provider = await quotations.loadProvider(expertId);
    invoice.business_identity = quotations.buildIdentitySnapshot(provider);
  }

  const pdf = await renderInvoicePdf(invoice, invoice.payments, invoices.paymentSummary(invoice, invoice.payments));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoice.reference}.pdf"`);
  return res.send(pdf);
}

// --- Jobs ------------------------------------------------------------------

async function listJobs(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const items = await jobs.listJobs(expertId, {
    status: req.query?.status ? String(req.query.status) : null,
  });
  return res.json({ success: true, data: { jobs: items } });
}

async function getJob(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  return res.json({ success: true, data: await jobs.getJob(expertId, req.params.id) });
}

async function createManualJob(req, res) {
  const payload = parse(manualJobSchema, req.body, "Check the job details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const job = await jobs.createManualJob(expertId, payload);
  return res.status(201).json({ success: true, message: "Job added.", data: job });
}

async function createJobFromQuotation(req, res) {
  const payload = parse(jobFromQuotationSchema, req.body, "Check the job details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const job = await jobs.createFromQuotation(expertId, req.params.quotationId, payload);
  return res.status(201).json({ success: true, message: "Job created.", data: job });
}

async function updateJobStatus(req, res) {
  const payload = parse(jobStatusSchema, req.body, "Check the job status.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const job = await jobs.updateJobStatus(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Job updated.", data: job });
}

async function reviseJobDate(req, res) {
  const payload = parse(jobDateRevisionSchema, req.body, "Give a reason for the date change.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const result = await jobs.reviseExpectedDate(expertId, req.params.id, payload);
  return res.json({ success: true, message: result.message, data: result });
}

async function listJobDateRevisions(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const revisions = await jobs.listDateRevisions(expertId, req.params.id);
  return res.json({ success: true, data: { revisions } });
}

module.exports = {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  deleteEstimate,
  recordEstimateActuals,
  getEstimateQuoteBasis,
  listQuotations,
  getQuotation,
  createQuotation,
  updateQuotation,
  sendQuotation,
  extendQuotationValidity,
  reviseQuotation,
  deleteQuotation,
  listQuotationVersions,
  downloadQuotationPdf,
  listInvoices,
  getInvoice,
  createInvoiceFromQuotation,
  updateInvoice,
  sendInvoice,
  cancelInvoice,
  recordPayment,
  deletePayment,
  downloadInvoicePdf,
  listJobs,
  getJob,
  createManualJob,
  createJobFromQuotation,
  updateJobStatus,
  reviseJobDate,
  listJobDateRevisions,
};
