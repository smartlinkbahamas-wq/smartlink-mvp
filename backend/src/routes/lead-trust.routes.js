const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");
const {
  postStartEmailVerification,
  postConfirmEmailVerification,
  postReportSuspiciousLead,
  getSuspiciousLeadReports,
  patchSuspiciousLeadReport,
  getMyNotificationPreferences,
  patchMyNotificationPreferences,
} = require("../controllers/lead-trust.controller");

const leadTrustRouter = express.Router();

// Sending a code costs an email, so it is tighter than the general public
// ceiling. Keyed per IP and per address, so one person cannot exhaust the
// allowance for a whole office behind a shared connection.
const verificationSendLimit = createFixedWindowLimiter({
  name: "email-verification-send",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: 5,
  keyFn: (req) =>
    `${req.ip || "unknown"}::${String(req.body?.email || "").trim().toLowerCase()}`,
  message: "Too many codes requested. Please wait before asking for another.",
});

// Confirming is cheap but guessable, so it gets its own, looser ceiling on top
// of the per-challenge attempt counter in the service.
const verificationConfirmLimit = createFixedWindowLimiter({
  name: "email-verification-confirm",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: 20,
  message: "Too many attempts. Please wait and try again.",
});

// Public: the customer has no account at this point in the flow.
leadTrustRouter.post("/verify-email/start", verificationSendLimit, asyncHandler(postStartEmailVerification));
leadTrustRouter.post("/verify-email/confirm", verificationConfirmLimit, asyncHandler(postConfirmEmailVerification));

// Provider.
leadTrustRouter.post("/suspicious-leads", requireUserAuth, asyncHandler(postReportSuspiciousLead));
leadTrustRouter.get("/notification-preferences", requireUserAuth, asyncHandler(getMyNotificationPreferences));
leadTrustRouter.patch("/notification-preferences", requireUserAuth, asyncHandler(patchMyNotificationPreferences));

// Administrator review queue. Reuses the existing lead-management permission
// rather than inventing a new one for a queue of leads.
leadTrustRouter.get(
  "/admin/suspicious-leads",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.LEAD_ASSIGN),
  asyncHandler(getSuspiciousLeadReports),
);
leadTrustRouter.patch(
  "/admin/suspicious-leads/:id",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.LEAD_ASSIGN),
  asyncHandler(patchSuspiciousLeadReport),
);

module.exports = {
  leadTrustRouter,
};
