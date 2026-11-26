const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const c = require("../controllers/support.controller");

// Provider.
const supportRouter = express.Router();
supportRouter.get("/", requireUserAuth, asyncHandler(c.getMyTickets));
supportRouter.post("/", requireUserAuth, asyncHandler(c.createMyTicket));
supportRouter.get("/:id", requireUserAuth, asyncHandler(c.getMyTicket));
supportRouter.post("/:id/messages", requireUserAuth, asyncHandler(c.postMyMessage));
supportRouter.post("/:id/request-original", requireUserAuth, asyncHandler(c.postRequestOriginal));

// Administrator. Behind the existing lead-management permission: the people
// who triage leads and chase jobs are the people who handle complaints.
const supportAdminRouter = express.Router();
const guards = [requireAdminAuth, requirePermission(ADMIN_PERMISSIONS.LEAD_ASSIGN)];

supportAdminRouter.get("/", ...guards, asyncHandler(c.getTickets));
supportAdminRouter.get("/:id", ...guards, asyncHandler(c.getTicket));
supportAdminRouter.patch("/:id", ...guards, asyncHandler(c.patchTicket));
supportAdminRouter.post("/:id/messages", ...guards, asyncHandler(c.postAdminMessage));
supportAdminRouter.post("/:id/summary", ...guards, asyncHandler(c.postProviderSummary));
supportAdminRouter.post("/:id/share-original", ...guards, asyncHandler(c.postShareDecision));

module.exports = {
  supportRouter,
  supportAdminRouter,
};
