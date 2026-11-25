const { z } = require("zod");
const { SUSPICIOUS_REASONS, LEAD_ALERT_MODES } = require("../services/lead-trust.service");

const startVerificationSchema = z.object({
  email: z.string().trim().email().max(320),
});

const confirmVerificationSchema = z.object({
  email: z.string().trim().email().max(320),
  // Digits only, exactly six: anything else is a typo or a probe, and
  // rejecting it here keeps the attempt counter for real guesses.
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

const reportSuspiciousLeadSchema = z.object({
  introductionRequestId: z.string().uuid(),
  reason: z.enum(SUSPICIOUS_REASONS),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

const reviewSuspiciousLeadSchema = z.object({
  status: z.enum(["new", "under_review", "actioned", "dismissed"]),
  reviewOutcome: z.string().trim().max(200).optional().or(z.literal("")),
  reviewNotes: z.string().trim().max(2000).optional().or(z.literal("")),
});

const notificationPreferencesSchema = z.object({
  leadAlerts: z.enum(LEAD_ALERT_MODES),
});

module.exports = {
  startVerificationSchema,
  confirmVerificationSchema,
  reportSuspiciousLeadSchema,
  reviewSuspiciousLeadSchema,
  notificationPreferencesSchema,
};
