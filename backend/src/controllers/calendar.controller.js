const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const { resolveExpertIdForUser } = require("../utils/expert-identity");
const calendar = require("../services/calendar.service");

/**
 * Business calendar, provider-facing.
 *
 * Phase 1 only: the provider manages their own diary. There is no public
 * availability endpoint yet -- that is phase 2, and it must never expose other
 * customers' booking details, which is why getAvailability returns free/busy
 * slots rather than the bookings themselves.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "That date is not valid.");

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use a time like 14:30.");

const workingHoursSchema = z.object({
  days: z
    .array(
      z.object({
        weekday: z.coerce.number().int().min(0).max(6),
        isOpen: z.boolean(),
        opensAt: clockTime,
        closesAt: clockTime,
      }),
    )
    .min(1)
    .max(7),
});

const blockSchema = z.object({
  startsOn: isoDate,
  endsOn: isoDate.optional(),
  // Both or neither: one alone cannot be interpreted, which the database also
  // enforces.
  startsAt: clockTime.optional().nullable(),
  endsAt: clockTime.optional().nullable(),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
}).superRefine((value, ctx) => {
  const hasStart = Boolean(value.startsAt);
  const hasEnd = Boolean(value.endsAt);
  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasStart ? "endsAt" : "startsAt"],
      message: "Give both a start and an end time, or leave both empty to block the whole day.",
    });
  }
});

const bookingSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  customerName: z.string().trim().min(1, "Enter the customer's name.").max(200),
  customerEmail: z.string().trim().email("Enter a valid email address.").max(320).optional().or(z.literal("")),
  customerPhone: z.string().trim().max(60).optional().or(z.literal("")),
  serviceMenuItemId: z.string().uuid().optional().nullable(),
  serviceName: z.string().trim().max(200).optional().or(z.literal("")),
  scheduledOn: isoDate,
  startsAt: clockTime,
  durationMinutes: z.coerce.number().int().positive("Duration must be more than zero.").max(60 * 24),
  status: z.enum(["pending", "confirmed", "completed", "cancelled"]).optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  // An explicit decision to double-book, not a default.
  allowOverlap: z.boolean().optional(),
});

function parse(schema, payload, message) {
  try {
    return schema.parse(payload || {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, { code: "validation_error", fields: error.flatten() });
    }
    throw error;
  }
}

async function getWorkingHours(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const hours = await calendar.getWorkingHours(expertId);
  return res.json({ success: true, data: { workingHours: hours } });
}

async function setWorkingHours(req, res) {
  const payload = parse(workingHoursSchema, req.body, "Check your working hours.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const hours = await calendar.setWorkingHours(expertId, payload.days);
  return res.json({ success: true, message: "Working hours saved.", data: { workingHours: hours } });
}

async function listBlocks(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const blocks = await calendar.listBlocks(expertId, {
    from: req.query?.from ? String(req.query.from) : null,
    to: req.query?.to ? String(req.query.to) : null,
  });
  return res.json({ success: true, data: { blocks } });
}

async function createBlock(req, res) {
  const payload = parse(blockSchema, req.body, "Check the dates you want to block.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const block = await calendar.createBlock(expertId, payload);
  return res.status(201).json({ success: true, message: "Time blocked.", data: block });
}

async function deleteBlock(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const removed = await calendar.deleteBlock(expertId, req.params.id);
  return res.json({ success: true, message: "Block removed.", data: removed });
}

async function listBookings(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const bookings = await calendar.listBookings(expertId, {
    from: req.query?.from ? String(req.query.from) : null,
    to: req.query?.to ? String(req.query.to) : null,
    status: req.query?.status ? String(req.query.status) : null,
  });
  return res.json({ success: true, data: { bookings } });
}

async function createBooking(req, res) {
  const payload = parse(bookingSchema, req.body, "Check the booking details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const result = await calendar.createBooking(expertId, payload, {
    allowOverlap: Boolean(payload.allowOverlap),
  });
  return res.status(201).json({
    success: true,
    message: result.conflicts.length
      ? "Booking saved, but it overlaps another appointment."
      : "Booking saved.",
    data: result,
  });
}

async function updateBooking(req, res) {
  const payload = parse(bookingSchema, req.body, "Check the booking details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const result = await calendar.updateBooking(expertId, req.params.id, payload, {
    allowOverlap: Boolean(payload.allowOverlap),
  });
  return res.json({
    success: true,
    message: result.conflicts.length
      ? "Booking saved, but it overlaps another appointment."
      : "Booking saved.",
    data: result,
  });
}

async function updateBookingStatus(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const booking = await calendar.updateBookingStatus(expertId, req.params.id, String(req.body?.status));
  return res.json({ success: true, message: "Booking updated.", data: booking });
}

async function deleteBooking(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const removed = await calendar.deleteBooking(expertId, req.params.id);
  return res.json({ success: true, message: "Booking removed.", data: removed });
}

async function getAvailability(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const date = String(req.query?.date || new Date().toISOString().slice(0, 10));
  const availability = await calendar.getAvailability(expertId, date, {
    slotMinutes: req.query?.slot ? Number(req.query.slot) : 30,
    durationMinutes: req.query?.duration ? Number(req.query.duration) : null,
  });
  return res.json({ success: true, data: availability });
}

module.exports = {
  getWorkingHours,
  setWorkingHours,
  listBlocks,
  createBlock,
  deleteBlock,
  listBookings,
  createBooking,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  getAvailability,
};
