const express = require("express");

const { createLead } = require("../controllers/lead.controller");
const { asyncHandler } = require("../utils/async-handler");
const { createFixedWindowLimiter } = require("../middleware/public-rate-limit");
const { env } = require("../config/env");

// Unauthenticated and writes rows, so it gets a per-IP ceiling.
const publicWriteLimit = createFixedWindowLimiter({
  name: "leads",
  windowMinutes: env.PUBLIC_RATE_LIMIT_WINDOW_MINUTES,
  max: env.PUBLIC_RATE_LIMIT_MAX,
  message: "Too many submissions from this network. Please try again later.",
});


const leadRouter = express.Router();

leadRouter.post("/", publicWriteLimit, asyncHandler(createLead));

module.exports = {
  leadRouter,
};

