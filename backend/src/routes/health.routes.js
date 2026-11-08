const express = require("express");

const { getHealth, getMailHealth } = require("../controllers/health.controller");

const healthRouter = express.Router();

healthRouter.get("/", getHealth);
healthRouter.get("/mail", getMailHealth);

module.exports = {
  healthRouter,
};

