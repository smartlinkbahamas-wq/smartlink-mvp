const { ZodError } = require("zod");

const { AppError } = require("../utils/app-error");
const { customerDecisionSchema } = require("../validators/business.validator");
const {
  resolveSecureLink,
  issueLinkCode,
  verifyLinkCode,
  consumeSecureLink,
  contextFromRequest,
} = require("../services/secure-link.service");
const quotations = require("../services/quotation.service");
const invoices = require("../services/invoice.service");
const { renderQuotationPdf, renderInvoicePdf } = require("../services/document-pdf.service");
const { sendVerificationCodeEmail } = require("../services/mail.service");

/**
 * Customer-facing document endpoints. No account, no session.
 *
 * Authorisation is the secure link alone for reading, and the link plus an
 * emailed code for acting. Everything returned goes through the service's
 * toCustomerView, which lists the permitted fields explicitly rather than
 * stripping forbidden ones -- so a new column added to quotations later cannot
 * silently become visible to customers.
 */

/**
 * The token is read from a header, never the query string.
 *
 * morgan("combined") logs full request URLs. A token in the query string would
 * be written into the access log on every request, and anyone who could read
 * that log could approve quotations on customers' behalf.
 */
function tokenFromRequest(req) {
  const header = req.get("x-document-token");
  const token = header || req.body?.token;
  if (!token) {
    throw new AppError("This link is not valid.", 400, { code: "missing_document_token" });
  }
  return String(token);
}

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

// --- Quotation -------------------------------------------------------------

async function getQuotationByLink(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "quotation_approval",
    context: contextFromRequest(req),
  });

  const quotation = await quotations.getQuotationForCustomer(link.subject_id);

  return res.json({
    success: true,
    data: {
      quotation: quotations.toCustomerView(quotation),
      // The page needs to know whether a code is outstanding so it can show
      // the right step, but never the code itself.
      requiresCode: Boolean(link.code_hash) && !link.code_verified_at,
      codeVerified: Boolean(link.code_verified_at),
      canRespond: ["sent", "changes_requested"].includes(quotation.status)
        && !quotations.isExpired(quotation),
    },
  });
}

/** Resends the verification code to the address the quotation was sent to. */
async function resendQuotationCode(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "quotation_approval",
    context: contextFromRequest(req),
  });

  const { code, expiresMinutes } = await issueLinkCode(link.id);

  // Sent only to the address stored on the link, never to one supplied in the
  // request. Otherwise the code could be redirected to an attacker.
  const delivery = await sendVerificationCodeEmail({
    to: link.recipient_email,
    code,
    expiresMinutes,
  });

  return res.json({
    success: true,
    message: delivery.sent
      ? "A new code is on its way."
      : "We could not send the code. Please contact the provider directly.",
    data: { delivered: delivery.sent, expiresMinutes },
  });
}

/**
 * Records the customer's decision.
 *
 * Order matters: resolve the link, verify the code, record the decision, then
 * consume the link. Consuming last means a failure part-way leaves the
 * customer able to try again rather than holding a spent link and an
 * unanswered quotation.
 */
async function respondToQuotation(req, res) {
  const payload = parse(customerDecisionSchema, req.body, "Check your response and try again.");
  const context = contextFromRequest(req);

  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "quotation_approval",
    context,
  });

  await verifyLinkCode(link.id, payload.code, context);

  const quotation = await quotations.recordCustomerDecision(link.subject_id, {
    decision: payload.decision,
    message: payload.message,
    acceptedTerms: payload.acceptedTerms,
    method: "email_code",
  });

  await consumeSecureLink(link.id, { detail: payload.decision, context });

  const messages = {
    approve: "Thank you. The provider has been told you approved this quotation.",
    decline: "Thank you. The provider has been told you declined this quotation.",
    request_changes: "Thank you. The provider has been sent your requested changes.",
  };

  return res.json({
    success: true,
    message: messages[payload.decision],
    data: { status: quotation.status, reference: quotation.reference },
  });
}

async function downloadQuotationByLink(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "quotation_approval",
    context: contextFromRequest(req),
  });

  const quotation = await quotations.getQuotationForCustomer(link.subject_id);
  const pdf = await renderQuotationPdf(quotation);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${quotation.reference}.pdf"`);
  return res.send(pdf);
}

// --- Invoice ---------------------------------------------------------------

async function getInvoiceByLink(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "invoice_view",
    context: contextFromRequest(req),
  });

  const { invoice, payments } = await invoices.getInvoiceForCustomer(link.subject_id);
  return res.json({ success: true, data: { invoice: invoices.toCustomerView(invoice, payments) } });
}

async function downloadInvoiceByLink(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "invoice_view",
    context: contextFromRequest(req),
  });

  const { invoice, payments } = await invoices.getInvoiceForCustomer(link.subject_id);
  const pdf = await renderInvoicePdf(invoice, payments, invoices.paymentSummary(invoice, payments));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoice.reference}.pdf"`);
  return res.send(pdf);
}

module.exports = {
  getQuotationByLink,
  resendQuotationCode,
  respondToQuotation,
  downloadQuotationByLink,
  getInvoiceByLink,
  downloadInvoiceByLink,
};
