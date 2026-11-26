const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const c = require("../controllers/reporting.controller");

const reportingRouter = express.Router();

// A provider's own figures, including their profitability.
reportingRouter.get("/mine", requireUserAuth, asyncHandler(c.getMyReport));

// Platform figures. Behind report.view, and carrying no provider cost data.
reportingRouter.get(
  "/platform",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.REPORT_VIEW),
  asyncHandler(c.getPlatformReport),
);

module.exports = {
  reportingRouter,
};
