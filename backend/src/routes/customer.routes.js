const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const c = require("../controllers/customer.controller");

const customerRouter = express.Router();

// "/merge" is declared before "/:id" so the literal segment is not matched as
// an id -- the same trap that would have made /service-menu/mine resolve as a
// provider id.
customerRouter.get("/", requireUserAuth, asyncHandler(c.listCustomers));
customerRouter.post("/", requireUserAuth, asyncHandler(c.createCustomer));
customerRouter.post("/merge", requireUserAuth, asyncHandler(c.mergeCustomers));
customerRouter.get("/:id", requireUserAuth, asyncHandler(c.getCustomer));
customerRouter.patch("/:id", requireUserAuth, asyncHandler(c.updateCustomer));
customerRouter.post("/:id/archive", requireUserAuth, asyncHandler(c.archiveCustomer));

module.exports = {
  customerRouter,
};
