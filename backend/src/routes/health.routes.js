const express = require("express");

const { getHealth, getMailHealth, getSchedulerHealth } = require("../controllers/health.controller");

const healthRouter = express.Router();

healthRouter.get("/", getHealth);
healthRouter.get("/mail", getMailHealth);
healthRouter.get("/scheduler", getSchedulerHealth);

module.exports = {
  healthRouter,
};

