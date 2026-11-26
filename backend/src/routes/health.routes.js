const express = require("express");

const { getHealth, getMailHealth, getSchedulerHealth } = require("../controllers/health.controller");
const { getAiHealth } = require("../controllers/ai-intake.controller");

const healthRouter = express.Router();

healthRouter.get("/", getHealth);
healthRouter.get("/mail", getMailHealth);
healthRouter.get("/scheduler", getSchedulerHealth);
healthRouter.get("/ai", getAiHealth);

module.exports = {
  healthRouter,
};

