const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Business calendar, phase 1.
 *
 * What a provider can do here: see their week, add bookings by hand including
 * ones that came from outside SmartLink, block time they are unavailable, and
 * have confirmed SmartLink work appear automatically.
 *
 * Customers cannot yet view availability or request bookings -- that is phase
 * 2, and it needs the public-facing availability read this file already
 * provides, so the shape is deliberate rather than accidental.
 *
 * All times are local date + clock time with no timezone. An appointment is
 * "three o'clock on Tuesday" to both parties; storing it as an instant would
 * shift it across a daylight-saving boundary, so a 3pm booking made in
 * November would read 2pm in April.
 */

const NOT_INSTALLED = "The calendar is not set up yet. Run sql/install_calendar.sql.";

const ACTIVE_STATUSES = ["pending", "confirmed"];
const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled"];

const DEFAULT_SLOT_MINUTES = 30;

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "calendar_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/** "14:30" or "14:30:00" -> 870. The single place clock maths happens. */
function toMinutes(time) {
  if (!time) return 0;
  const [hours, minutes] = String(time).split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function toTimeString(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Two ranges overlap when each starts before the other ends. */
function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// --- Working hours ---------------------------------------------------------

async function getWorkingHours(expertId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("provider_working_hours")
    .select("*")
    .eq("expert_id", expertId)
    .order("weekday");

  if (error) guard(error, "Could not load your working hours.");

  // A provider with no rows yet gets a sensible default rather than a calendar
  // showing no available time at all.
  if (!data || data.length === 0) {
    return Array.from({ length: 7 }, (_, weekday) => ({
      expert_id: expertId,
      weekday,
      is_open: weekday >= 1 && weekday <= 5,
      opens_at: "09:00:00",
      closes_at: "17:00:00",
    }));
  }

  return data;
}

async function setWorkingHours(expertId, days) {
  const supabase = requireSupabase();

  const rows = days.map((day) => ({
    expert_id: expertId,
    weekday: day.weekday,
    is_open: Boolean(day.isOpen),
    opens_at: day.opensAt,
    closes_at: day.closesAt,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("provider_working_hours")
    .upsert(rows, { onConflict: "expert_id,weekday" });

  if (error) {
    if (error.code === "23514") {
      throw new AppError("Closing time must be after opening time.", 400, {
        code: "invalid_working_hours",
      });
    }
    guard(error, "Could not save your working hours.");
  }

  return getWorkingHours(expertId);
}

// --- Blocked periods -------------------------------------------------------

async function listBlocks(expertId, { from = null, to = null } = {}) {
  const supabase = requireSupabase();
  let query = supabase
    .from("availability_blocks")
    .select("*")
    .eq("expert_id", expertId)
    .order("starts_on");

  // A block overlaps the window if it starts before the window ends and ends
  // after the window starts -- not simply "starts inside the window", which
  // would miss a block spanning the whole range.
  if (to) query = query.lte("starts_on", to);
  if (from) query = query.gte("ends_on", from);

  const { data, error } = await query;
  if (error) guard(error, "Could not load your blocked dates.");
  return data || [];
}

async function createBlock(expertId, payload) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("availability_blocks")
    .insert({
      expert_id: expertId,
      starts_on: payload.startsOn,
      ends_on: payload.endsOn || payload.startsOn,
      starts_at: payload.startsAt || null,
      ends_at: payload.endsAt || null,
      reason: payload.reason?.trim() || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23514") {
      throw new AppError(
        "Check the dates and times: the end must come after the start, and a part-day block needs both a start and an end time.",
        400,
        { code: "invalid_block" },
      );
    }
    if (error.code === "23503") {
      throw new AppError("No provider profile is linked to this account.", 403, {
        code: "expert_profile_not_linked",
      });
    }
    guard(error, "Could not block that time.");
  }

  return data;
}

async function deleteBlock(expertId, blockId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("availability_blocks")
    .delete()
    .eq("id", blockId)
    .eq("expert_id", expertId)
    .select("id")
    .maybeSingle();

  if (error) guard(error, "Could not remove that block.");
  if (!data) {
    throw new AppError("That blocked period could not be found.", 404, { code: "block_not_found" });
  }
  return { id: data.id };
}

// --- Bookings --------------------------------------------------------------

/** Adds the end time, so the calendar grid does not recompute it per booking. */
function decorate(booking) {
  if (!booking) return booking;
  const start = toMinutes(booking.starts_at);
  return {
    ...booking,
    ends_at: toTimeString(start + Number(booking.duration_minutes || 0)),
    starts_at_minutes: start,
  };
}

async function listBookings(expertId, { from, to, status = null } = {}) {
  const supabase = requireSupabase();
  let query = supabase
    .from("bookings")
    .select("*")
    .eq("expert_id", expertId)
    .order("scheduled_on")
    .order("starts_at");

  if (from) query = query.gte("scheduled_on", from);
  if (to) query = query.lte("scheduled_on", to);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) guard(error, "Could not load your bookings.");
  return (data || []).map(decorate);
}

async function getBooking(expertId, bookingId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that booking.");
  if (!data) {
    throw new AppError("That booking could not be found.", 404, { code: "booking_not_found" });
  }
  return decorate(data);
}

/**
 * Finds bookings that clash with a proposed slot.
 *
 * Checked in the service rather than enforced by a database exclusion
 * constraint. A constraint would need the btree_gist extension and would give
 * the provider an opaque violation; this names the conflicting appointment,
 * which is what they actually need in order to decide what to do.
 *
 * Cancelled and completed bookings are ignored: neither occupies the diary.
 */
async function findConflicts(expertId, { scheduledOn, startsAt, durationMinutes, excludeId = null }) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("bookings")
    .select("id, customer_name, service_name, starts_at, duration_minutes, status")
    .eq("expert_id", expertId)
    .eq("scheduled_on", scheduledOn)
    .in("status", ACTIVE_STATUSES);

  if (error) guard(error, "Could not check that time.");

  const start = toMinutes(startsAt);
  const end = start + Number(durationMinutes);

  return (data || [])
    .filter((booking) => booking.id !== excludeId)
    .filter((booking) => {
      const otherStart = toMinutes(booking.starts_at);
      return overlaps(start, end, otherStart, otherStart + Number(booking.duration_minutes || 0));
    })
    .map((booking) => ({
      id: booking.id,
      customerName: booking.customer_name,
      serviceName: booking.service_name,
      startsAt: String(booking.starts_at).slice(0, 5),
      endsAt: toTimeString(toMinutes(booking.starts_at) + Number(booking.duration_minutes || 0)),
    }));
}

/**
 * Creates a booking.
 *
 * A clash is reported, not silently prevented, and a provider may override it:
 * double-booking is sometimes deliberate, and a calendar that refuses what the
 * provider knows to be fine is a calendar they stop using. `allowOverlap`
 * makes that an explicit decision rather than an accident.
 */
async function createBooking(expertId, payload, { allowOverlap = false } = {}) {
  const supabase = requireSupabase();

  const conflicts = await findConflicts(expertId, {
    scheduledOn: payload.scheduledOn,
    startsAt: payload.startsAt,
    durationMinutes: payload.durationMinutes || 60,
  });

  if (conflicts.length > 0 && !allowOverlap) {
    throw new AppError(
      `That time clashes with ${conflicts[0].customerName} at ${conflicts[0].startsAt}.`,
      409,
      { code: "booking_conflict", conflicts },
    );
  }

  // Links the booking to a customer record, creating one if needed, so the
  // calendar feeds the same customer list as everything else.
  let customerId = payload.customerId || null;
  if (!customerId) {
    const { findOrCreateForDocument } = require("./customer.service");
    customerId = await findOrCreateForDocument(expertId, {
      email: payload.customerEmail,
      fullName: payload.customerName,
      phone: payload.customerPhone,
    });
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      expert_id: expertId,
      customer_id: customerId,
      customer_name: String(payload.customerName).trim(),
      customer_email: payload.customerEmail?.trim().toLowerCase() || null,
      customer_phone: payload.customerPhone?.trim() || null,
      service_menu_item_id: payload.serviceMenuItemId || null,
      service_name: payload.serviceName?.trim() || null,
      scheduled_on: payload.scheduledOn,
      starts_at: payload.startsAt,
      duration_minutes: payload.durationMinutes || 60,
      status: payload.status || "confirmed",
      // Forced: a provider entering a booking by hand did not get it from the
      // platform, and letting the client say otherwise would corrupt the
      // SmartLink-versus-own-work split in reporting.
      source: "manual",
      notes: payload.notes?.trim() || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23503") {
      throw new AppError("No provider profile is linked to this account.", 403, {
        code: "expert_profile_not_linked",
      });
    }
    guard(error, "Could not save that booking.");
  }

  return { booking: decorate(data), conflicts };
}

async function updateBooking(expertId, bookingId, payload, { allowOverlap = false } = {}) {
  const supabase = requireSupabase();
  await getBooking(expertId, bookingId); // ownership check

  const conflicts = await findConflicts(expertId, {
    scheduledOn: payload.scheduledOn,
    startsAt: payload.startsAt,
    durationMinutes: payload.durationMinutes || 60,
    excludeId: bookingId,
  });

  if (conflicts.length > 0 && !allowOverlap) {
    throw new AppError(
      `That time clashes with ${conflicts[0].customerName} at ${conflicts[0].startsAt}.`,
      409,
      { code: "booking_conflict", conflicts },
    );
  }

  const { data, error } = await supabase
    .from("bookings")
    .update({
      customer_name: String(payload.customerName).trim(),
      customer_email: payload.customerEmail?.trim().toLowerCase() || null,
      customer_phone: payload.customerPhone?.trim() || null,
      service_menu_item_id: payload.serviceMenuItemId || null,
      service_name: payload.serviceName?.trim() || null,
      scheduled_on: payload.scheduledOn,
      starts_at: payload.startsAt,
      duration_minutes: payload.durationMinutes || 60,
      notes: payload.notes?.trim() || null,
      // Moving an appointment means the customer should be reminded about the
      // new time, so a reminder already sent no longer counts.
      reminder_sent_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not save that booking.");
  if (!data) {
    throw new AppError("That booking could not be found.", 404, { code: "booking_not_found" });
  }

  return { booking: decorate(data), conflicts };
}

async function updateBookingStatus(expertId, bookingId, status) {
  if (!BOOKING_STATUSES.includes(status)) {
    throw new AppError("Choose pending, confirmed, completed or cancelled.", 400, {
      code: "invalid_booking_status",
    });
  }

  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("bookings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not update that booking.");
  if (!data) {
    throw new AppError("That booking could not be found.", 404, { code: "booking_not_found" });
  }
  return decorate(data);
}

async function deleteBooking(expertId, bookingId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("bookings")
    .delete()
    .eq("id", bookingId)
    .eq("expert_id", expertId)
    .select("id")
    .maybeSingle();

  if (error) guard(error, "Could not remove that booking.");
  if (!data) {
    throw new AppError("That booking could not be found.", 404, { code: "booking_not_found" });
  }
  return { id: data.id };
}

// --- Availability ----------------------------------------------------------

/**
 * Free slots on a given day.
 *
 * Working hours, minus existing bookings, minus blocked periods -- exactly the
 * three things specified. This is also what phase 2 will serve to customers,
 * which is why it returns slots rather than a rendered view.
 *
 * Slots are aligned to the hour grid rather than to the end of the previous
 * appointment, because a diary of 9:00, 9:30, 10:00 is what a person expects;
 * 9:00, 9:45, 10:30 reads as broken even though it wastes less time.
 */
async function getAvailability(expertId, date, { slotMinutes = DEFAULT_SLOT_MINUTES, durationMinutes = null } = {}) {
  const weekday = new Date(`${date}T12:00:00`).getDay();

  const [hours, bookings, blocks] = await Promise.all([
    getWorkingHours(expertId),
    listBookings(expertId, { from: date, to: date }),
    listBlocks(expertId, { from: date, to: date }),
  ]);

  const day = hours.find((row) => row.weekday === weekday);
  if (!day || !day.is_open) {
    return { date, weekday, isWorkingDay: false, slots: [], reason: "Not a working day." };
  }

  const opens = toMinutes(day.opens_at);
  const closes = toMinutes(day.closes_at);
  const needed = durationMinutes || slotMinutes;

  // Whole-day blocks have no times, so they cover the full working day.
  const blocked = blocks.map((block) =>
    block.starts_at && block.ends_at
      ? { start: toMinutes(block.starts_at), end: toMinutes(block.ends_at), reason: block.reason }
      : { start: opens, end: closes, reason: block.reason },
  );

  const taken = bookings
    .filter((booking) => ACTIVE_STATUSES.includes(booking.status))
    .map((booking) => ({
      start: toMinutes(booking.starts_at),
      end: toMinutes(booking.starts_at) + Number(booking.duration_minutes || 0),
    }));

  const slots = [];
  for (let start = opens; start + needed <= closes; start += slotMinutes) {
    const end = start + needed;
    const clashesWithBooking = taken.some((t) => overlaps(start, end, t.start, t.end));
    const clashesWithBlock = blocked.some((b) => overlaps(start, end, b.start, b.end));

    slots.push({
      startsAt: toTimeString(start),
      endsAt: toTimeString(end),
      available: !clashesWithBooking && !clashesWithBlock,
      reason: clashesWithBooking ? "booked" : clashesWithBlock ? "blocked" : null,
    });
  }

  return {
    date,
    weekday,
    isWorkingDay: true,
    opensAt: toTimeString(opens),
    closesAt: toTimeString(closes),
    slots,
  };
}

module.exports = {
  BOOKING_STATUSES,
  toMinutes,
  toTimeString,
  overlaps,
  getWorkingHours,
  setWorkingHours,
  listBlocks,
  createBlock,
  deleteBlock,
  listBookings,
  getBooking,
  findConflicts,
  createBooking,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  getAvailability,
};
