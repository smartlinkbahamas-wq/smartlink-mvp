const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const c = require("../controllers/improvement.controller");

const improvementRouter = express.Router();
const guards = [requireAdminAuth, requirePermission(ADMIN_PERMISSIONS.REPORT_VIEW)];

// "/candidates" before "/:id" so the literal segment is not read as an id.
improvementRouter.get("/candidates", ...guards, asyncHandler(c.getCandidates));
improvementRouter.get("/", ...guards, asyncHandler(c.getActions));
improvementRouter.post("/", ...guards, asyncHandler(c.postAction));
improvementRouter.patch("/:id", ...guards, asyncHandler(c.patchAction));

module.exports = {
  improvementRouter,
};
