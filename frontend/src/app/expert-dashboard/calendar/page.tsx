"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listBookings,
  createBooking,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  listBlocks,
  createBlock,
  deleteBlock,
  getWorkingHours,
  setWorkingHours,
} from "@/lib/business-hub-api";
import type {
  AvailabilityBlock,
  Booking,
  BookingConflict,
  BookingStatus,
  WorkingHoursDay,
} from "@/types";

/**
 * Business calendar, phase 1.
 *
 * Day, week and month views; bookings added by hand including ones from
 * outside SmartLink; blocked dates; working hours.
 *
 * Dates are handled as plain YYYY-MM-DD strings throughout. Using Date objects
 * for calendar arithmetic invites timezone bugs -- `new Date("2026-12-01")` is
 * parsed as UTC midnight, which is the previous day for anyone west of
 * Greenwich, so a booking made in the Bahamas would land on the wrong square.
 */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_STYLES: Record<BookingStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/50",
  confirmed: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900/50",
  completed: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-900/50",
  cancelled: "bg-gray-100 text-gray-500 border-gray-200 line-through dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600",
};

/** Local YYYY-MM-DD. Never toISOString(), which converts to UTC first. */
function toKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parsed as local noon, so a timezone shift can never move the calendar day. */
function fromKey(key: string) {
  return new Date(`${key}T12:00:00`);
}

function addDays(key: string, days: number) {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return toKey(date);
}

function startOfWeek(key: string) {
  const date = fromKey(key);
  date.setDate(date.getDate() - date.getDay());
  return toKey(date);
}

function startOfMonth(key: string) {
  const date = fromKey(key);
  date.setDate(1);
  return toKey(date);
}

function endOfMonth(key: string) {
  const date = fromKey(key);
  date.setMonth(date.getMonth() + 1, 0);
  return toKey(date);
}

function formatLong(key: string) {
  return fromKey(key).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function formatMonth(key: string) {
  return fromKey(key).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

const EMPTY_FORM = {
  id: null as string | null,
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  serviceName: "",
  scheduledOn: "",
  startsAt: "09:00",
  durationMinutes: "60",
  status: "confirmed" as BookingStatus,
  notes: "",
};

export default function CalendarPage() {
  const router = useRouter();
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [anchor, setAnchor] = useState(() => toKey(new Date()));

  const [bookings, setBookings] = useState<Booking[]>([]);
  const [blocks, setBlocks] = useState<AvailabilityBlock[]>([]);
  const [hours, setHours] = useState<WorkingHoursDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [conflicts, setConflicts] = useState<BookingConflict[]>([]);

  const [hoursOpen, setHoursOpen] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<WorkingHoursDay[]>([]);
  const [savingHours, setSavingHours] = useState(false);

  const [blockOpen, setBlockOpen] = useState(false);
  const [blockForm, setBlockForm] = useState({ startsOn: "", endsOn: "", startsAt: "", endsAt: "", reason: "" });
  const [savingBlock, setSavingBlock] = useState(false);

  // The window the current view covers. Month view pads to whole weeks so the
  // grid is rectangular.
  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    const from = startOfWeek(startOfMonth(anchor));
    const monthEnd = endOfMonth(anchor);
    const to = addDays(startOfWeek(monthEnd), 6);
    return { from, to };
  }, [view, anchor]);

  const reload = useCallback(
    async (token: string) => {
      const [b, bl] = await Promise.all([
        listBookings(token, range.from, range.to),
        listBlocks(token, range.from, range.to),
      ]);
      setBookings(b);
      setBlocks(bl);
    },
    [range.from, range.to],
  );

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        const session = await getSessionMe();
        if (!active) return;
        if (!canUseExpertSection(session.role)) {
          router.replace("/login");
          return;
        }
        const token = getAdminAccessToken();
        if (!token) {
          router.replace("/login");
          return;
        }

        const [b, bl, h] = await Promise.all([
          listBookings(token, range.from, range.to),
          listBlocks(token, range.from, range.to),
          getWorkingHours(token),
        ]);
        if (!active) return;
        setBookings(b);
        setBlocks(bl);
        setHours(h);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your calendar.");
      } finally {
        if (active) setLoading(false);
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [router, range.from, range.to]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
  }

  const bookingsByDate = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const booking of bookings) {
      if (!map.has(booking.scheduled_on)) map.set(booking.scheduled_on, []);
      map.get(booking.scheduled_on)!.push(booking);
    }
    return map;
  }, [bookings]);

  /** A date is blocked if any block's range covers it. */
  const blockedDates = useMemo(() => {
    const set = new Set<string>();
    for (const block of blocks) {
      let cursor = block.starts_on;
      // Bounded at 400 iterations: a corrupt range should not hang the page.
      for (let i = 0; i < 400 && cursor <= block.ends_on; i += 1) {
        set.add(cursor);
        cursor = addDays(cursor, 1);
      }
    }
    return set;
  }, [blocks]);

  const openHoursByWeekday = useMemo(() => {
    const map = new Map<number, WorkingHoursDay>();
    for (const day of hours) map.set(day.weekday, day);
    return map;
  }, [hours]);

  function openNew(date?: string) {
    setForm({ ...EMPTY_FORM, scheduledOn: date || anchor });
    setFormError("");
    setConflicts([]);
    setEditorOpen(true);
  }

  function openEdit(booking: Booking) {
    setForm({
      id: booking.id,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email || "",
      customerPhone: booking.customer_phone || "",
      serviceName: booking.service_name || "",
      scheduledOn: booking.scheduled_on,
      startsAt: String(booking.starts_at).slice(0, 5),
      durationMinutes: String(booking.duration_minutes),
      status: booking.status,
      notes: booking.notes || "",
    });
    setFormError("");
    setConflicts([]);
    setEditorOpen(true);
  }

  async function handleSave(allowOverlap = false) {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");

    const payload = {
      customerName: form.customerName.trim(),
      customerEmail: form.customerEmail.trim() || undefined,
      customerPhone: form.customerPhone.trim() || undefined,
      serviceName: form.serviceName.trim() || undefined,
      scheduledOn: form.scheduledOn,
      startsAt: form.startsAt,
      durationMinutes: Number(form.durationMinutes) || 60,
      status: form.status,
      notes: form.notes.trim() || undefined,
      allowOverlap,
    };

    try {
      const result = form.id
        ? await updateBooking(form.id, payload, token)
        : await createBooking(payload, token);
      await reload(token);
      setNotice(result.message);
      setEditorOpen(false);
      setConflicts([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save that booking.";
      setFormError(message);
      // A clash is offered as a choice rather than a dead end: double-booking
      // is sometimes deliberate.
      if (/clashes with/i.test(message)) {
        setConflicts([{ id: "", customerName: "", serviceName: null, startsAt: "", endsAt: "" }]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleStatus(booking: Booking, status: BookingStatus) {
    const token = requireToken();
    if (!token) return;
    setBusyId(booking.id);
    setError("");
    try {
      await updateBookingStatus(booking.id, status, token);
      await reload(token);
      setNotice(`${booking.customer_name} marked ${status}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that booking.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(booking: Booking) {
    if (!window.confirm(`Remove the booking for ${booking.customer_name}?`)) return;
    const token = requireToken();
    if (!token) return;
    setBusyId(booking.id);
    try {
      await deleteBooking(booking.id, token);
      await reload(token);
      setNotice("Booking removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that booking.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveHours() {
    const token = requireToken();
    if (!token) return;
    setSavingHours(true);
    setError("");
    try {
      const saved = await setWorkingHours(
        hoursDraft.map((day) => ({
          weekday: day.weekday,
          isOpen: day.is_open,
          opensAt: String(day.opens_at).slice(0, 5),
          closesAt: String(day.closes_at).slice(0, 5),
        })),
        token,
      );
      setHours(saved);
      setHoursOpen(false);
      setNotice("Working hours saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your working hours.");
    } finally {
      setSavingHours(false);
    }
  }

  async function handleSaveBlock() {
    const token = requireToken();
    if (!token) return;
    setSavingBlock(true);
    setError("");
    try {
      await createBlock(
        {
          startsOn: blockForm.startsOn,
          endsOn: blockForm.endsOn || blockForm.startsOn,
          startsAt: blockForm.startsAt || null,
          endsAt: blockForm.endsAt || null,
          reason: blockForm.reason.trim() || undefined,
        },
        token,
      );
      await reload(token);
      setBlockOpen(false);
      setBlockForm({ startsOn: "", endsOn: "", startsAt: "", endsAt: "", reason: "" });
      setNotice("Time blocked.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not block that time.");
    } finally {
      setSavingBlock(false);
    }
  }

  async function handleDeleteBlock(block: AvailabilityBlock) {
    const token = requireToken();
    if (!token) return;
    setBusyId(block.id);
    try {
      await deleteBlock(block.id, token);
      await reload(token);
      setNotice("Block removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that block.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white";
  const labelClass = "mb-1 block text-sm font-medium text-gray-900 dark:text-white";

  const step = view === "day" ? 1 : view === "week" ? 7 : 0;
  const title = view === "month" ? formatMonth(anchor) : view === "day" ? formatLong(anchor) : `${formatLong(range.from).split(",")[1]?.trim() || range.from} — ${formatLong(range.to).split(",")[1]?.trim() || range.to}`;

  const days: string[] = [];
  for (let cursor = range.from; cursor <= range.to; cursor = addDays(cursor, 1)) days.push(cursor);

  function BookingChip({ booking }: { booking: Booking }) {
    return (
      <button
        type="button"
        onClick={() => openEdit(booking)}
        className={`w-full truncate rounded border px-1.5 py-1 text-left text-xs ${STATUS_STYLES[booking.status]}`}
        title={`${String(booking.starts_at).slice(0, 5)}–${booking.ends_at} · ${booking.customer_name}${booking.service_name ? ` · ${booking.service_name}` : ""}`}
      >
        <span className="font-semibold">{String(booking.starts_at).slice(0, 5)}</span>{" "}
        {booking.customer_name}
      </button>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <CalendarDays className="h-6 w-6 text-blue-600" aria-hidden="true" />
            Calendar
          </h1>
          <p className="mt-1 text-gray-500">
            Your bookings, including work that came from outside SmartLink.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setHoursDraft(hours.map((day) => ({ ...day })));
              setHoursOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            Working hours
          </button>
          <button
            type="button"
            onClick={() => {
              setBlockForm({ startsOn: anchor, endsOn: anchor, startsAt: "", endsAt: "", reason: "" });
              setBlockOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Clock className="h-4 w-4" aria-hidden="true" />
            Block time
          </button>
          <button
            type="button"
            onClick={() => openNew()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a booking
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">{error}</div>
      ) : null}
      {notice && !error ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="underline">Dismiss</button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor(view === "month" ? toKey(new Date(fromKey(anchor).setMonth(fromKey(anchor).getMonth() - 1))) : addDays(anchor, -step))}
            className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(toKey(new Date()))}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setAnchor(view === "month" ? toKey(new Date(fromKey(anchor).setMonth(fromKey(anchor).getMonth() + 1))) : addDays(anchor, step))}
            className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span className="ml-2 font-semibold text-gray-900 dark:text-white">{title}</span>
        </div>

        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600" role="tablist">
          {(["day", "week", "month"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              onClick={() => setView(option)}
              className={`px-4 py-2 text-sm font-medium capitalize first:rounded-l-lg last:rounded-r-lg ${
                view === option
                  ? "bg-blue-600 text-white"
                  : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {view === "day" ? (
        <div className="rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          {blockedDates.has(anchor) ? (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
              You have blocked time on this day.
            </p>
          ) : null}
          {!openHoursByWeekday.get(fromKey(anchor).getDay())?.is_open ? (
            <p className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:bg-gray-700/40 dark:text-gray-300">
              {WEEKDAY_NAMES[fromKey(anchor).getDay()]} is outside your working hours.
            </p>
          ) : null}

          {(bookingsByDate.get(anchor) || []).length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">Nothing booked.</p>
          ) : (
            <ul className="space-y-2">
              {(bookingsByDate.get(anchor) || []).map((booking) => (
                <li key={booking.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-100 p-3 dark:border-gray-700">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 dark:text-white">
                      {String(booking.starts_at).slice(0, 5)}–{booking.ends_at} · {booking.customer_name}
                    </p>
                    <p className="text-sm text-gray-500">
                      {booking.service_name || "No service recorded"}
                      {booking.customer_phone ? ` · ${booking.customer_phone}` : ""}
                      {booking.source === "smartlink" ? " · from SmartLink" : ""}
                    </p>
                    {booking.notes ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{booking.notes}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[booking.status]}`}>
                      {booking.status}
                    </span>
                    <label className="sr-only" htmlFor={`st-${booking.id}`}>Change status</label>
                    <select
                      id={`st-${booking.id}`}
                      value=""
                      disabled={busyId === booking.id}
                      onChange={(e) => e.target.value && handleStatus(booking, e.target.value as BookingStatus)}
                      className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                    >
                      <option value="">Change…</option>
                      {(["pending", "confirmed", "completed", "cancelled"] as const)
                        .filter((s) => s !== booking.status)
                        .map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button type="button" onClick={() => openEdit(booking)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                      Edit
                    </button>
                    <button type="button" onClick={() => handleDelete(booking)} disabled={busyId === booking.id} className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20" aria-label={`Remove booking for ${booking.customer_name}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="grid grid-cols-7 border-b border-gray-100 text-center text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">
            {WEEKDAY_SHORT.map((name) => (
              <div key={name} className="px-2 py-2">{name}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((key) => {
              const date = fromKey(key);
              const inMonth = view === "week" || date.getMonth() === fromKey(anchor).getMonth();
              const isToday = key === toKey(new Date());
              const dayBookings = bookingsByDate.get(key) || [];
              const isBlocked = blockedDates.has(key);
              const isOpen = openHoursByWeekday.get(date.getDay())?.is_open;

              return (
                <div
                  key={key}
                  className={`min-h-[7rem] border-b border-r border-gray-100 p-1.5 dark:border-gray-700 ${
                    !inMonth ? "bg-gray-50/60 dark:bg-gray-900/30" : ""
                  } ${isBlocked ? "bg-amber-50/70 dark:bg-amber-900/10" : ""} ${
                    !isOpen && inMonth && !isBlocked ? "bg-gray-50/40 dark:bg-gray-900/20" : ""
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        setAnchor(key);
                        setView("day");
                      }}
                      className={`h-6 w-6 rounded-full text-xs font-semibold ${
                        isToday ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                      }`}
                      aria-label={`View ${formatLong(key)}`}
                    >
                      {date.getDate()}
                    </button>
                    <button
                      type="button"
                      onClick={() => openNew(key)}
                      className="rounded p-0.5 text-gray-300 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
                      aria-label={`Add a booking on ${formatLong(key)}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {dayBookings.slice(0, 3).map((booking) => (
                      <BookingChip key={booking.id} booking={booking} />
                    ))}
                    {dayBookings.length > 3 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setAnchor(key);
                          setView("day");
                        }}
                        className="w-full text-left text-xs text-blue-600 hover:underline"
                      >
                        +{dayBookings.length - 3} more
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {blocks.length > 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Blocked time in this period</h2>
          <ul className="space-y-1.5">
            {blocks.map((block) => (
              <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-gray-900 dark:text-white">
                  {block.starts_on === block.ends_on ? formatLong(block.starts_on) : `${formatLong(block.starts_on)} — ${formatLong(block.ends_on)}`}
                  {block.starts_at && block.ends_at
                    ? `, ${String(block.starts_at).slice(0, 5)}–${String(block.ends_at).slice(0, 5)}`
                    : ", all day"}
                  {block.reason ? ` · ${block.reason}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => handleDeleteBlock(block)}
                  disabled={busyId === block.id}
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20"
                  aria-label="Remove this block"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editorOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10" role="dialog" aria-modal="true" aria-labelledby="booking-title" onClick={() => !saving && setEditorOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <h2 id="booking-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                {form.id ? "Edit booking" : "Add a booking"}
              </h2>
              <button type="button" onClick={() => setEditorOpen(false)} disabled={saving} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                <p>{formError}</p>
                {conflicts.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => handleSave(true)}
                    disabled={saving}
                    className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Book it anyway
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="bk-name" className={labelClass}>Customer name</label>
                  <input id="bk-name" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="bk-service" className={labelClass}>Service <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="bk-service" value={form.serviceName} onChange={(e) => setForm({ ...form, serviceName: e.target.value })} placeholder="Haircut" className={inputClass} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="bk-email" className={labelClass}>Email <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="bk-email" type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} className={inputClass} />
                  <p className="mt-1 text-xs text-gray-500">Needed to send the customer a reminder.</p>
                </div>
                <div>
                  <label htmlFor="bk-phone" className={labelClass}>Telephone <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="bk-phone" value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} className={inputClass} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="bk-date" className={labelClass}>Date</label>
                  <input id="bk-date" type="date" value={form.scheduledOn} onChange={(e) => setForm({ ...form, scheduledOn: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="bk-time" className={labelClass}>Start time</label>
                  <input id="bk-time" type="time" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="bk-duration" className={labelClass}>Minutes</label>
                  <input id="bk-duration" inputMode="numeric" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value.replace(/\D/g, "") })} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="bk-status" className={labelClass}>Status</label>
                <select id="bk-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as BookingStatus })} className={inputClass}>
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div>
                <label htmlFor="bk-notes" className={labelClass}>Notes <span className="font-normal text-gray-500">(optional)</span></label>
                <textarea id="bk-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputClass} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setEditorOpen(false)} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
              <button
                type="button"
                onClick={() => handleSave(false)}
                disabled={saving || !form.customerName.trim() || !form.scheduledOn || !form.startsAt}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {form.id ? "Save changes" : "Add booking"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {hoursOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10" role="dialog" aria-modal="true" aria-labelledby="hours-title" onClick={() => !savingHours && setHoursOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="hours-title" className="text-lg font-semibold text-gray-900 dark:text-white">Working hours</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Used to work out when you are available. Bookings outside these hours are still
                  allowed — this is a default, not a restriction.
                </p>
              </div>
              <button type="button" onClick={() => setHoursOpen(false)} disabled={savingHours} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2">
              {hoursDraft.map((day, index) => (
                <div key={day.weekday} className="flex flex-wrap items-center gap-2">
                  <label className="flex w-32 items-center gap-2 text-sm text-gray-900 dark:text-white">
                    <input
                      type="checkbox"
                      checked={day.is_open}
                      onChange={(e) =>
                        setHoursDraft((rows) => rows.map((r, i) => (i === index ? { ...r, is_open: e.target.checked } : r)))
                      }
                    />
                    {WEEKDAY_NAMES[day.weekday]}
                  </label>
                  <input
                    type="time"
                    value={String(day.opens_at).slice(0, 5)}
                    disabled={!day.is_open}
                    onChange={(e) => setHoursDraft((rows) => rows.map((r, i) => (i === index ? { ...r, opens_at: e.target.value } : r)))}
                    className="rounded-lg border border-gray-300 p-2 text-sm disabled:opacity-40 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                    aria-label={`${WEEKDAY_NAMES[day.weekday]} opening time`}
                  />
                  <span className="text-gray-400">to</span>
                  <input
                    type="time"
                    value={String(day.closes_at).slice(0, 5)}
                    disabled={!day.is_open}
                    onChange={(e) => setHoursDraft((rows) => rows.map((r, i) => (i === index ? { ...r, closes_at: e.target.value } : r)))}
                    className="rounded-lg border border-gray-300 p-2 text-sm disabled:opacity-40 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                    aria-label={`${WEEKDAY_NAMES[day.weekday]} closing time`}
                  />
                </div>
              ))}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setHoursOpen(false)} disabled={savingHours} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
              <button type="button" onClick={handleSaveHours} disabled={savingHours} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {savingHours ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save hours
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {blockOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10" role="dialog" aria-modal="true" aria-labelledby="block-title" onClick={() => !savingBlock && setBlockOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="block-title" className="text-lg font-semibold text-gray-900 dark:text-white">Block time</h2>
                <p className="mt-1 text-sm text-gray-500">Mark yourself unavailable. Leave the times empty to block whole days.</p>
              </div>
              <button type="button" onClick={() => setBlockOpen(false)} disabled={savingBlock} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="bl-from" className={labelClass}>From</label>
                  <input id="bl-from" type="date" value={blockForm.startsOn} onChange={(e) => setBlockForm({ ...blockForm, startsOn: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="bl-to" className={labelClass}>To</label>
                  <input id="bl-to" type="date" value={blockForm.endsOn} onChange={(e) => setBlockForm({ ...blockForm, endsOn: e.target.value })} className={inputClass} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="bl-start" className={labelClass}>Start time <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="bl-start" type="time" value={blockForm.startsAt} onChange={(e) => setBlockForm({ ...blockForm, startsAt: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="bl-end" className={labelClass}>End time <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="bl-end" type="time" value={blockForm.endsAt} onChange={(e) => setBlockForm({ ...blockForm, endsAt: e.target.value })} className={inputClass} />
                </div>
              </div>
              <p className="text-xs text-gray-500">Give both times or neither — one alone cannot be interpreted.</p>
              <div>
                <label htmlFor="bl-reason" className={labelClass}>Reason <span className="font-normal text-gray-500">(optional)</span></label>
                <input id="bl-reason" value={blockForm.reason} onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })} placeholder="Holiday" className={inputClass} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setBlockOpen(false)} disabled={savingBlock} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
              <button type="button" onClick={handleSaveBlock} disabled={savingBlock || !blockForm.startsOn} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {savingBlock ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Block time
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
