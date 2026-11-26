const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const c = require("../controllers/survey.controller");

const surveyRouter = express.Router();

// Provider.
surveyRouter.get("/pending", requireUserAuth, asyncHandler(c.getPendingSurveys));
surveyRouter.post("/provider", requireUserAuth, asyncHandler(c.postProviderSurvey));
surveyRouter.get("/mine", requireUserAuth, asyncHandler(c.getMySurveyStatistics));

// Administrator.
surveyRouter.get(
  "/platform",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.REPORT_VIEW),
  asyncHandler(c.getPlatformSurveyStatistics),
);

module.exports = {
  surveyRouter,
};
