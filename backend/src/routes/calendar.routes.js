const express = require("express");

const { asyncHandler } = require("../utils/async-handler");
const { requireUserAuth } = require("../middleware/user-auth");
const c = require("../controllers/calendar.controller");

const calendarRouter = express.Router();

// Literal segments before parameterised ones, so "/bookings" and "/blocks" are
// not matched as ids.
calendarRouter.get("/working-hours", requireUserAuth, asyncHandler(c.getWorkingHours));
calendarRouter.put("/working-hours", requireUserAuth, asyncHandler(c.setWorkingHours));

calendarRouter.get("/availability", requireUserAuth, asyncHandler(c.getAvailability));

calendarRouter.get("/blocks", requireUserAuth, asyncHandler(c.listBlocks));
calendarRouter.post("/blocks", requireUserAuth, asyncHandler(c.createBlock));
calendarRouter.delete("/blocks/:id", requireUserAuth, asyncHandler(c.deleteBlock));

calendarRouter.get("/bookings", requireUserAuth, asyncHandler(c.listBookings));
calendarRouter.post("/bookings", requireUserAuth, asyncHandler(c.createBooking));
calendarRouter.patch("/bookings/:id", requireUserAuth, asyncHandler(c.updateBooking));
calendarRouter.patch("/bookings/:id/status", requireUserAuth, asyncHandler(c.updateBookingStatus));
calendarRouter.delete("/bookings/:id", requireUserAuth, asyncHandler(c.deleteBooking));

module.exports = {
  calendarRouter,
};
