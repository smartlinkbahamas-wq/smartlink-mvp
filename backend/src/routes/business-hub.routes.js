const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");
const c = require("../controllers/business-hub.controller");
const d = require("../controllers/customer-document.controller");

/**
 * Business Hub routes.
 *
 * Provider routes all sit behind requireUserAuth and resolve the provider from
 * the session. Customer document routes are unauthenticated by design -- the
 * secure link is the credential -- so they carry rate limits.
 */

const businessHubRouter = express.Router();

// --- QuickCost -------------------------------------------------------------
businessHubRouter.get("/quickcost", requireUserAuth, asyncHandler(c.listEstimates));
businessHubRouter.post("/quickcost", requireUserAuth, asyncHandler(c.createEstimate));
businessHubRouter.get("/quickcost/:id", requireUserAuth, asyncHandler(c.getEstimate));
businessHubRouter.patch("/quickcost/:id", requireUserAuth, asyncHandler(c.updateEstimate));
businessHubRouter.delete("/quickcost/:id", requireUserAuth, asyncHandler(c.deleteEstimate));
businessHubRouter.patch("/quickcost/:id/actuals", requireUserAuth, asyncHandler(c.recordEstimateActuals));
businessHubRouter.get("/quickcost/:id/quote-basis", requireUserAuth, asyncHandler(c.getEstimateQuoteBasis));

// --- Quotations -------------------------------------------------------------
businessHubRouter.get("/quotations", requireUserAuth, asyncHandler(c.listQuotations));
businessHubRouter.post("/quotations", requireUserAuth, asyncHandler(c.createQuotation));
businessHubRouter.get("/quotations/:id", requireUserAuth, asyncHandler(c.getQuotation));
businessHubRouter.patch("/quotations/:id", requireUserAuth, asyncHandler(c.updateQuotation));
businessHubRouter.delete("/quotations/:id", requireUserAuth, asyncHandler(c.deleteQuotation));
businessHubRouter.post("/quotations/:id/send", requireUserAuth, asyncHandler(c.sendQuotation));
businessHubRouter.post("/quotations/:id/extend", requireUserAuth, asyncHandler(c.extendQuotationValidity));
businessHubRouter.post("/quotations/:id/revise", requireUserAuth, asyncHandler(c.reviseQuotation));
businessHubRouter.get("/quotations/:id/versions", requireUserAuth, asyncHandler(c.listQuotationVersions));
businessHubRouter.get("/quotations/:id/pdf", requireUserAuth, asyncHandler(c.downloadQuotationPdf));

// --- Invoices ----------------------------------------------------------------
businessHubRouter.get("/invoices", requireUserAuth, asyncHandler(c.listInvoices));
businessHubRouter.post(
  "/invoices/from-quotation/:quotationId",
  requireUserAuth,
  asyncHandler(c.createInvoiceFromQuotation),
);
businessHubRouter.get("/invoices/:id", requireUserAuth, asyncHandler(c.getInvoice));
businessHubRouter.patch("/invoices/:id", requireUserAuth, asyncHandler(c.updateInvoice));
businessHubRouter.post("/invoices/:id/send", requireUserAuth, asyncHandler(c.sendInvoice));
businessHubRouter.post("/invoices/:id/cancel", requireUserAuth, asyncHandler(c.cancelInvoice));
businessHubRouter.get("/invoices/:id/pdf", requireUserAuth, asyncHandler(c.downloadInvoicePdf));
businessHubRouter.post("/invoices/:id/payments", requireUserAuth, asyncHandler(c.recordPayment));
businessHubRouter.delete(
  "/invoices/:id/payments/:paymentId",
  requireUserAuth,
  asyncHandler(c.deletePayment),
);

// --- Jobs ---------------------------------------------------------------------
// "/jobs/from-quotation/:quotationId" is declared before "/jobs/:id" so the
// literal segment is not matched as an id.
businessHubRouter.get("/jobs", requireUserAuth, asyncHandler(c.listJobs));
businessHubRouter.post("/jobs", requireUserAuth, asyncHandler(c.createManualJob));
businessHubRouter.post(
  "/jobs/from-quotation/:quotationId",
  requireUserAuth,
  asyncHandler(c.createJobFromQuotation),
);
businessHubRouter.get("/jobs/:id", requireUserAuth, asyncHandler(c.getJob));
businessHubRouter.patch("/jobs/:id/status", requireUserAuth, asyncHandler(c.updateJobStatus));
businessHubRouter.post("/jobs/:id/revise-date", requireUserAuth, asyncHandler(c.reviseJobDate));
businessHubRouter.get("/jobs/:id/date-revisions", requireUserAuth, asyncHandler(c.listJobDateRevisions));

// --- Customer document access (public, link-authenticated) --------------------

const documentReadLimit = createFixedWindowLimiter({
  name: "customer-document-read",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_READ_RATE_LIMIT_MAX,
  message: "Too many requests. Please try again shortly.",
});

// Sending a code costs an email; responding is the action itself. Both are
// tighter than the read ceiling.
const documentActionLimit = createFixedWindowLimiter({
  name: "customer-document-action",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: 20,
  message: "Too many attempts. Please wait and try again.",
});

const customerDocumentRouter = express.Router();

// POST for reads, so the token travels in the body or a header rather than a
// query string that morgan would write into the access log.
customerDocumentRouter.post("/quotation", documentReadLimit, asyncHandler(d.getQuotationByLink));
customerDocumentRouter.post("/quotation/pdf", documentReadLimit, asyncHandler(d.downloadQuotationByLink));
customerDocumentRouter.post("/quotation/code", documentActionLimit, asyncHandler(d.resendQuotationCode));
customerDocumentRouter.post("/quotation/respond", documentActionLimit, asyncHandler(d.respondToQuotation));
customerDocumentRouter.post("/invoice", documentReadLimit, asyncHandler(d.getInvoiceByLink));
customerDocumentRouter.post("/invoice/pdf", documentReadLimit, asyncHandler(d.downloadInvoiceByLink));

module.exports = {
  businessHubRouter,
  customerDocumentRouter,
};
