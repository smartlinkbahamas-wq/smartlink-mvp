const express = require("express");

const { recommendMatches } = require("../controllers/matches.controller");
const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");

// Unauthenticated and writes rows, so it gets a per-IP ceiling.
const publicReadLimit = createFixedWindowLimiter({
  name: "matches",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_READ_RATE_LIMIT_MAX,
  message: "Too many match requests. Please wait a moment and try again.",
});


const matchesRouter = express.Router();

matchesRouter.post("/recommend", publicReadLimit, asyncHandler(recommendMatches));

module.exports = {
  matchesRouter,
};

