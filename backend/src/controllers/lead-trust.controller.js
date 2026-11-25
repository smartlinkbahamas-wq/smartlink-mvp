const { ZodError } = require("zod");
const { AppError } = require("../utils/app-error");
const {
  startVerificationSchema,
  confirmVerificationSchema,
  reportSuspiciousLeadSchema,
  reviewSuspiciousLeadSchema,
  notificationPreferencesSchema,
} = require("../validators/lead-trust.validator");
const {
  startEmailVerification,
  confirmEmailVerification,
  reportSuspiciousLead,
  listSuspiciousLeadReports,
  reviewSuspiciousLeadReport,
  getNotificationPreferences,
  setLeadAlertMode,
} = require("../services/lead-trust.service");
const { resolveExpertIdForUser } = require("../utils/expert-identity");

function parseWithSchema(schema, payload, message) {
  try {
    return schema.parse(payload || {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, { code: "validation_error", fields: error.flatten() });
    }
    throw error;
  }
}

// --- Customer email verification (public) ----------------------------------

async function postStartEmailVerification(req, res) {
  const payload = parseWithSchema(startVerificationSchema, req.body, "Enter a valid email address.");
  const result = await startEmailVerification(payload.email, req.ip || null);

  const { sendVerificationCodeEmail } = require("../services/mail.service");
  const delivery = await sendVerificationCodeEmail({
    to: payload.email,
    code: result.code,
    expiresMinutes: result.expiresMinutes,
  });

  return res.status(201).json({
    success: true,
    message: "Verification code sent.",
    data: {
      verificationId: result.verificationId,
      expiresAt: result.expiresAt,
      delivered: delivery.sent,
      // The code itself is never returned. If mail is not configured the
      // caller is told delivery failed rather than handed the code.
    },
  });
}

async function postConfirmEmailVerification(req, res) {
  const payload = parseWithSchema(confirmVerificationSchema, req.body, "Enter the 6-digit code.");
  const result = await confirmEmailVerification(payload.email, payload.code);
  return res.status(200).json({ success: true, message: "Email verified.", data: result });
}

// --- Suspicious lead reporting (provider) ----------------------------------

async function postReportSuspiciousLead(req, res) {
  const payload = parseWithSchema(reportSuspiciousLeadSchema, req.body, "Invalid report payload.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);

  const report = await reportSuspiciousLead({
    expertId,
    introductionRequestId: payload.introductionRequestId,
    reason: payload.reason,
    notes: payload.notes || null,
    reportedByUserId: req.user?.userId || null,
  });

  return res.status(201).json({
    success: true,
    message: "Thanks — an administrator will review this. Declining it will not count against you.",
    data: report,
  });
}

// --- Suspicious lead review (admin) ----------------------------------------

async function getSuspiciousLeadReports(req, res) {
  const status = req.query?.status ? String(req.query.status) : null;
  const reports = await listSuspiciousLeadReports({ status });
  return res.status(200).json({ success: true, data: { reports } });
}

async function patchSuspiciousLeadReport(req, res) {
  const payload = parseWithSchema(reviewSuspiciousLeadSchema, req.body, "Invalid review payload.");
  const report = await reviewSuspiciousLeadReport({
    reportId: req.params.id,
    status: payload.status,
    reviewOutcome: payload.reviewOutcome || null,
    reviewNotes: payload.reviewNotes || null,
    reviewedByUserId: req.user?.userId || req.adminUser?.userId || null,
  });
  return res.status(200).json({ success: true, message: "Report updated.", data: report });
}

// --- Notification preferences (provider) -----------------------------------

async function getMyNotificationPreferences(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const preferences = await getNotificationPreferences(expertId);
  return res.status(200).json({ success: true, data: { preferences } });
}

async function patchMyNotificationPreferences(req, res) {
  const payload = parseWithSchema(
    notificationPreferencesSchema,
    req.body,
    "Choose immediate, daily summary, or off.",
  );
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const preferences = await setLeadAlertMode(expertId, payload.leadAlerts);
  return res.status(200).json({ success: true, message: "Notification settings saved.", data: { preferences } });
}

module.exports = {
  postStartEmailVerification,
  postConfirmEmailVerification,
  postReportSuspiciousLead,
  getSuspiciousLeadReports,
  patchSuspiciousLeadReport,
  getMyNotificationPreferences,
  patchMyNotificationPreferences,
};
