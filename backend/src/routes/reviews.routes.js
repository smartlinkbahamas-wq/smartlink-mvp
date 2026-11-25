const express = require("express");

const { postReviewResponse, submitPublicReview } = require("../controllers/reviews.controller");
const { patchReviewModerationByAdmin } = require("../controllers/admin.controller");
const { ADMIN_PERMISSIONS } = require("../constants/admin-rbac");
const { requireAdminAuth, requirePermission } = require("../middleware/admin-jwt-auth");
const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");

// Unauthenticated and writes rows, so it gets a per-IP ceiling.
const publicWriteLimit = createFixedWindowLimiter({
  name: "reviews",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_RATE_LIMIT_MAX,
  message: "Too many submissions from this network. Please try again later.",
});


const reviewsRouter = express.Router();

reviewsRouter.post("/public", publicWriteLimit, asyncHandler(submitPublicReview));
reviewsRouter.patch(
  "/:id/moderate",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.REVIEW_MODERATE_FINAL),
  asyncHandler(patchReviewModerationByAdmin),
);
reviewsRouter.post(
  "/:id/respond",
  requireAdminAuth,
  requirePermission(ADMIN_PERMISSIONS.REVIEW_MODERATE_FINAL),
  asyncHandler(postReviewResponse),
);

module.exports = {
  reviewsRouter,
};
