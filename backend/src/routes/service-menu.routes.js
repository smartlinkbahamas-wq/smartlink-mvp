const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");
const {
  getMyServiceMenu,
  postServiceMenuItem,
  patchServiceMenuItem,
  deleteServiceMenuItemHandler,
  patchServiceMenuOrder,
  getPublicServiceMenu,
} = require("../controllers/service-menu.controller");

const serviceMenuRouter = express.Router();

// The public read is unauthenticated, so it gets the read ceiling like the
// other public endpoints.
const publicReadLimit = createFixedWindowLimiter({
  name: "service-menu-public",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_READ_RATE_LIMIT_MAX,
  message: "Too many requests. Please try again shortly.",
});

// Provider: their own menu.
//
// Declared before the public ":expertId" route. Express matches in order, so
// with the parameterised route first, "/mine" would be read as an expert id
// and the provider would get an empty public menu instead of their own.
serviceMenuRouter.get("/mine", requireUserAuth, asyncHandler(getMyServiceMenu));
serviceMenuRouter.post("/mine", requireUserAuth, asyncHandler(postServiceMenuItem));
serviceMenuRouter.patch("/mine/order", requireUserAuth, asyncHandler(patchServiceMenuOrder));
serviceMenuRouter.patch("/mine/:id", requireUserAuth, asyncHandler(patchServiceMenuItem));
serviceMenuRouter.delete("/mine/:id", requireUserAuth, asyncHandler(deleteServiceMenuItemHandler));

// Public: a provider's published menu.
serviceMenuRouter.get("/:expertId", publicReadLimit, asyncHandler(getPublicServiceMenu));

module.exports = {
  serviceMenuRouter,
};
