const express = require("express");

const {
  getMySubmittedApplication,
  postSubmitExpertApplication,
  postOptimizeExpertProfile,
  uploadMiddleware,
  postUploadDocument,
  getExpertDashboardData,
  patchUpdateExpertProfile,
  patchOpportunityStatus,
} = require("../controllers/experts.controller");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { requireUserAuth } = require("../middleware/user-auth");
const { asyncHandler } = require("../utils/async-handler");

const expertsRouter = express.Router();

expertsRouter.get("/dashboard", asyncHandler(getExpertDashboardData));
expertsRouter.patch("/me", asyncHandler(patchUpdateExpertProfile));
expertsRouter.patch("/opportunities/:id/status", asyncHandler(patchOpportunityStatus));
expertsRouter.post("/applications/submit", asyncHandler(postSubmitExpertApplication));
expertsRouter.get("/applications/me", asyncHandler(getMySubmittedApplication));

expertsRouter.post(
  "/:id/optimize-profile",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.EXPERT_OPTIMIZE_PROFILE),
  asyncHandler(postOptimizeExpertProfile),
);


// Uses the shared requireUserAuth rather than a local copy: the previous
// inline shim threw a bare Error, which lost the 401 and surfaced an
// uploaded-document failure as a generic 500.
expertsRouter.post(
  "/documents/upload",
  requireUserAuth,
  uploadMiddleware,
  asyncHandler(postUploadDocument)
);

module.exports = {
  expertsRouter,
};
