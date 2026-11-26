const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");
const c = require("../controllers/job-monitoring.controller");

/**
 * Customer confirmation is unauthenticated by design -- the secure link is the
 * credential -- so it carries rate limits. Everything administrative sits
 * behind the existing lead-management permission rather than a new one.
 */

const confirmationLimit = createFixedWindowLimiter({
  name: "job-confirmation",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_READ_RATE_LIMIT_MAX,
  message: "Too many requests. Please try again shortly.",
});

const jobConfirmationRouter = express.Router();

// POST for the read too, so the token travels in a header rather than a query
// string that would be written into the access log.
jobConfirmationRouter.post("/", confirmationLimit, asyncHandler(c.getJobForConfirmation));
jobConfirmationRouter.post("/submit", confirmationLimit, asyncHandler(c.submitConfirmation));

const jobMonitoringAdminRouter = express.Router();

const adminGuards = [requireAdminAuth, requirePermission(ADMIN_PERMISSIONS.LEAD_ASSIGN)];

// Literal segments before parameterised ones.
jobMonitoringAdminRouter.get("/attention", ...adminGuards, asyncHandler(c.getJobsNeedingAttention));
jobMonitoringAdminRouter.get("/settings", ...adminGuards, asyncHandler(c.getMonitoringSettings));
jobMonitoringAdminRouter.patch("/settings", ...adminGuards, asyncHandler(c.patchMonitoringSettings));

// Declared before "/:id" so the literal segment is not read as a job id.
jobMonitoringAdminRouter.get("/date-revisions", ...adminGuards, asyncHandler(c.getPendingDateRevisions));
jobMonitoringAdminRouter.patch(
  "/date-revisions/:revisionId",
  ...adminGuards,
  asyncHandler(c.patchDateRevision),
);

jobMonitoringAdminRouter.get("/:id", ...adminGuards, asyncHandler(c.getJobMonitoringDetail));
jobMonitoringAdminRouter.post("/:id/attempts", ...adminGuards, asyncHandler(c.postVerificationAttempt));
jobMonitoringAdminRouter.post("/:id/unverifiable", ...adminGuards, asyncHandler(c.postMarkUnverifiable));
jobMonitoringAdminRouter.post("/:id/notes", ...adminGuards, asyncHandler(c.postAdminNote));

module.exports = {
  jobConfirmationRouter,
  jobMonitoringAdminRouter,
};
