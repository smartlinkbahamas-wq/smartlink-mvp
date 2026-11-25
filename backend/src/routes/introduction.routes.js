const express = require("express");

const { createIntroductions } = require("../controllers/introduction.controller");
const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");

// Unauthenticated and writes rows, so it gets a per-IP ceiling.
const publicWriteLimit = createFixedWindowLimiter({
  name: "introductions",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_RATE_LIMIT_MAX,
  message: "Too many submissions from this network. Please try again later.",
});


const introductionRouter = express.Router();

introductionRouter.post("/", publicWriteLimit, asyncHandler(createIntroductions));

module.exports = {
  introductionRouter,
};

