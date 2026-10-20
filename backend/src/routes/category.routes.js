const express = require("express");

const { getPublicCategories, getSpecializations } = require("../controllers/category.controller");
const { asyncHandler } = require("../utils/async-handler");

const categoryRouter = express.Router();

categoryRouter.get("/", asyncHandler(getPublicCategories));
categoryRouter.get("/specializations", asyncHandler(getSpecializations));

module.exports = {
  categoryRouter,
};
