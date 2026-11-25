const { requireSupabase } = require("../utils/supabase-guard");
const { register } = require("./scheduler.service");
const { sendMail, isMailConfigured } = require("./mail.service");
const { formatAmount } = require("../utils/money");

/**
 * What the scheduler actually runs.
 *
 * Kept separate from the runner so the runner has no opinion about the work,
 * and a new timed feature is a registration rather than an edit to the loop.
 *
 * Every handler returns a short string describing what it did. That string is
 * stored on the task row and shown by /api/health/scheduler, because "3
 * reminders sent" answers "is this working" and "last ran at 14:02" does not.
 */

const EXPIRY_WARNING_DAYS = 3;
const BATCH_LIMIT = 50;

function formatDate(value) {
  if (!value) return "soon";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "soon"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Tells a provider their quotation is about to expire.
 *
 * One reminder per quotation, tracked by expiry_reminder_sent_at. Without that
 * column this would email the same provider about the same document every
 * hour, which is exactly the reminder fatigue that makes people mute
 * everything.
 *
 * The marker is written BEFORE the email is sent. If the send fails the
 * provider misses one reminder; if the order were reversed, a crash between
 * send and marker would email them again next tick, and repeatedly.
 */
async function quotationExpiryReminders() {
  const supabase = requireSupabase();
  const horizon = new Date(Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: quotations, error } = await supabase
    .from("quotations")
    .select("id, expert_id, reference, job_name, customer_name, total, currency, valid_until")
    .eq("status", "sent")
    .is("expiry_reminder_sent_at", null)
    .not("valid_until", "is", null)
    .lte("valid_until", horizon)
    .gte("valid_until", new Date().toISOString())
    .limit(BATCH_LIMIT);

  if (error) throw new Error(`could not read quotations: ${error.message}`);
  if (!quotations || quotations.length === 0) return null;

  // One lookup for every provider in the batch, rather than one per quotation.
  const expertIds = [...new Set(quotations.map((q) => q.expert_id))];
  const { data: experts } = await supabase
    .from("experts")
    .select("expert_id, name, business_email, business_name")
    .in("expert_id", expertIds);

  const { data: links } = await supabase
    .from("expert_user_links")
    .select("expert_id, user_id")
    .in("expert_id", expertIds);

  const userIds = (links || []).map((l) => l.user_id).filter(Boolean);
  const { data: users } = userIds.length
    ? await supabase.from("user_profiles").select("user_id, email").in("user_id", userIds)
    : { data: [] };

  const emailByUserId = new Map((users || []).map((u) => [u.user_id, u.email]));
  const userIdByExpert = new Map((links || []).map((l) => [l.expert_id, l.user_id]));
  const expertsById = new Map((experts || []).map((e) => [e.expert_id, e]));

  let sent = 0;
  let skipped = 0;

  for (const quotation of quotations) {
    const expert = expertsById.get(quotation.expert_id);
    // The provider's business email if they set one, otherwise their login
    // address. A reminder is worth sending to whichever we actually have.
    const to =
      expert?.business_email || emailByUserId.get(userIdByExpert.get(quotation.expert_id));

    if (!to) {
      // Marked anyway: without an address this will never be sendable, and
      // leaving it unmarked means re-attempting it every hour forever.
      await supabase
        .from("quotations")
        .update({ expiry_reminder_sent_at: new Date().toISOString() })
        .eq("id", quotation.id);
      skipped += 1;
      continue;
    }

    await supabase
      .from("quotations")
      .update({ expiry_reminder_sent_at: new Date().toISOString() })
      .eq("id", quotation.id);

    const amount = formatAmount(quotation.total, quotation.currency);
    const expires = formatDate(quotation.valid_until);

    await sendMail({
      to,
      subject: `${quotation.reference} expires on ${expires}`,
      text: `Your quotation ${quotation.reference} for ${quotation.customer_name} (${amount}) expires on ${expires} and has not been answered. You can extend it or send a revision from your SmartLink dashboard.`,
      html: `
        <p>Your quotation <strong>${quotation.reference}</strong> for
        <strong>${quotation.customer_name}</strong> &mdash; ${amount} &mdash; expires on
        <strong>${expires}</strong> and has not been answered yet.</p>
        <p>You can extend the validity or send a revision from your Quotations page.</p>
        <p style="color:#6B7280;font-size:13px;">Job: ${quotation.job_name}</p>`,
    });

    sent += 1;
  }

  return `${sent} expiry reminder(s) sent${skipped ? `, ${skipped} with no address` : ""}`;
}

/**
 * One consolidated email per provider per day, for those who chose the daily
 * summary rather than immediate alerts.
 *
 * "Due today" is decided per provider from daily_summary_last_sent_at, not by
 * the tick. That is why the task can run every 15 minutes harmlessly: it sends
 * to whoever has not had one in 24 hours and ignores everyone else.
 */
async function dailyLeadSummary() {
  const supabase = requireSupabase();

  const { data: preferences, error } = await supabase
    .from("notification_preferences")
    .select("expert_id, daily_summary_last_sent_at")
    .eq("lead_alerts", "daily_summary");

  if (error) throw new Error(`could not read notification preferences: ${error.message}`);
  if (!preferences || preferences.length === 0) return null;

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const due = preferences.filter(
    (pref) =>
      !pref.daily_summary_last_sent_at ||
      new Date(pref.daily_summary_last_sent_at).getTime() < dayAgo,
  );

  if (due.length === 0) return null;

  // Checked after working out who is due, so the reason for not sending is
  // accurate rather than "nobody was due".
  if (!isMailConfigured()) {
    throw new Error("mail is not configured, so no summaries could be sent");
  }

  const expertIds = due.map((pref) => pref.expert_id);

  const { data: experts } = await supabase
    .from("experts")
    .select("expert_id, name, business_email")
    .in("expert_id", expertIds);

  const { data: links } = await supabase
    .from("expert_user_links")
    .select("expert_id, user_id")
    .in("expert_id", expertIds);

  const userIds = (links || []).map((l) => l.user_id).filter(Boolean);
  const { data: users } = userIds.length
    ? await supabase.from("user_profiles").select("user_id, email").in("user_id", userIds)
    : { data: [] };

  const emailByUserId = new Map((users || []).map((u) => [u.user_id, u.email]));
  const userIdByExpert = new Map((links || []).map((l) => [l.expert_id, l.user_id]));
  const expertsById = new Map((experts || []).map((e) => [e.expert_id, e]));

  // Opportunities from the last 24 hours, for everyone due, in one query.
  const since = new Date(dayAgo).toISOString();
  const { data: requests } = await supabase
    .from("introduction_requests")
    .select("id, expert_id, status, created_at, lead_id")
    .in("expert_id", expertIds)
    .gte("created_at", since);

  const byExpert = new Map();
  for (const request of requests || []) {
    if (!["submitted", "pending", "more_info"].includes(request.status)) continue;
    if (!byExpert.has(request.expert_id)) byExpert.set(request.expert_id, []);
    byExpert.get(request.expert_id).push(request);
  }

  let sent = 0;
  let quiet = 0;

  for (const pref of due) {
    const opportunities = byExpert.get(pref.expert_id) || [];

    // Nothing came in, so nothing is sent -- but the timestamp still moves, or
    // this provider would be re-evaluated every tick for the rest of the day.
    // An empty "you have 0 new leads" email every day is how a summary becomes
    // something people filter out.
    if (opportunities.length === 0) {
      await supabase
        .from("notification_preferences")
        .update({ daily_summary_last_sent_at: new Date().toISOString() })
        .eq("expert_id", pref.expert_id);
      quiet += 1;
      continue;
    }

    const expert = expertsById.get(pref.expert_id);
    const to = expert?.business_email || emailByUserId.get(userIdByExpert.get(pref.expert_id));

    if (!to) {
      await supabase
        .from("notification_preferences")
        .update({ daily_summary_last_sent_at: new Date().toISOString() })
        .eq("expert_id", pref.expert_id);
      continue;
    }

    // Written before sending, for the same reason as the expiry marker: a
    // crash mid-send should cost one summary, not produce a repeating one.
    await supabase
      .from("notification_preferences")
      .update({ daily_summary_last_sent_at: new Date().toISOString() })
      .eq("expert_id", pref.expert_id);

    const count = opportunities.length;
    await sendMail({
      to,
      subject: `${count} new ${count === 1 ? "opportunity" : "opportunities"} on SmartLink`,
      text: `You have ${count} new ${count === 1 ? "opportunity" : "opportunities"} waiting in your SmartLink dashboard from the past 24 hours. Open your Opportunities page to review them.`,
      html: `
        <p>You have <strong>${count} new ${count === 1 ? "opportunity" : "opportunities"}</strong>
        from the past 24 hours.</p>
        <p>Open your Opportunities page to review and respond to them.</p>
        <p style="color:#6B7280;font-size:13px;">You are receiving one summary a day because that
        is your notification setting. You can switch to immediate alerts, or off, under
        Notifications.</p>`,
    });

    sent += 1;
  }

  if (sent === 0 && quiet > 0) return `${quiet} provider(s) had no new opportunities`;
  return `${sent} daily summary email(s) sent${quiet ? `, ${quiet} had nothing to report` : ""}`;
}

/** Called once at boot. */
function registerAll() {
  register("quotation_expiry_reminders", quotationExpiryReminders);
  register("daily_lead_summary", dailyLeadSummary);
}

module.exports = {
  registerAll,
  quotationExpiryReminders,
  dailyLeadSummary,
};
