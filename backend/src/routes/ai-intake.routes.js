const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");
const c = require("../controllers/ai-intake.controller");

const aiIntakeRouter = express.Router();

// Public and costs money per call, so it is tighter than the general public
// write ceiling. A real person describes their need once or twice.
const suggestLimit = createFixedWindowLimiter({
  name: "ai-intake",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.AI_RATE_LIMIT_MAX,
  message: "Too many requests. Please use the questions instead.",
});

aiIntakeRouter.post("/suggest", suggestLimit, asyncHandler(c.postSuggest));

module.exports = {
  aiIntakeRouter,
  getAiHealth: c.getAiHealth,
};
