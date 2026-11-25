const express = require("express");

const { submitPrivateFeedback } = require("../controllers/feedback.controller");
const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");

// Unauthenticated and writes rows, so it gets a per-IP ceiling.
const publicWriteLimit = createFixedWindowLimiter({
  name: "feedback",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_RATE_LIMIT_MAX,
  message: "Too many submissions from this network. Please try again later.",
});


const feedbackRouter = express.Router();

feedbackRouter.post("/private", publicWriteLimit, asyncHandler(submitPrivateFeedback));

module.exports = {
  feedbackRouter,
};

