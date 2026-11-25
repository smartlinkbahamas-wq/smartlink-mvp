const { requireSupabase } = require("../utils/supabase-guard");
const { sendMail } = require("./mail.service");
const { createSecureLink, revokeLinksForSubject } = require("./secure-link.service");
const { env } = require("../config/env");
const monitoring = require("./job-monitoring.service");

/**
 * The scheduled half of job monitoring: works out what each job is due and
 * sends it.
 *
 * Kept apart from job-monitoring.service.js so the decision logic can be
 * tested without a mail service or a database -- `decideNotices` is a pure
 * function of a job, its settings and what has already been sent.
 */

const BATCH_LIMIT = 100;

function formatDate(value) {
  if (!value) return "the agreed date";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? "the agreed date"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Which notices a job is due, given the settings and what has already gone out.
 *
 * Pure: no database, no mail, no clock beyond the `days` it is handed. That is
 * what makes the schedule testable, and the schedule is the part most likely
 * to be wrong in a way nobody notices for weeks.
 *
 * Returns notices in the order they should be sent.
 */
function decideNotices({ status, days, alreadySent = [], settings, awaitingCustomerDays = null, hasConfirmation = false }) {
  const due = [];
  const sent = new Set(alreadySent);

  // Rule one: a settled job produces nothing. Completed, confirmed, cancelled,
  // disputed and unverifiable are all settled. This is the suppression that
  // decides whether providers keep notifications switched on.
  const OPEN = monitoring.OPEN_STATUSES;
  const isOpen = OPEN.includes(status);
  const awaitingCustomer = status === monitoring.AWAITING_CUSTOMER;

  if (!isOpen && !awaitingCustomer) return due;

  if (isOpen && days !== null) {
    // Approaching: remind the provider once, inside the window before the date.
    if (
      !sent.has("provider_reminder") &&
      days >= -settings.provider_reminder_days_before &&
      days < 0
    ) {
      due.push("provider_reminder");
    }

    // On the date: ask the provider to confirm the work is done.
    if (!sent.has("completion_request") && days >= settings.completion_request_days_after) {
      due.push("completion_request");
    }

    // Late.
    if (!sent.has("overdue_reminder") && days >= settings.overdue_reminder_days_after) {
      due.push("overdue_reminder");
    }

    if (!sent.has("admin_notified") && days >= settings.admin_notify_days_after) {
      due.push("admin_notified");
    }

    if (!sent.has("escalated") && days >= settings.escalation_days_after) {
      due.push("escalated");
    }
  }

  // Awaiting the customer: one extra automated nudge before an administrator
  // has to start telephoning. The calls are an operating cost that grows with
  // volume, so the software prompts first.
  if (
    awaitingCustomer &&
    !hasConfirmation &&
    settings.send_extra_reminder_before_calls &&
    !sent.has("extra_reminder") &&
    awaitingCustomerDays !== null &&
    awaitingCustomerDays >= settings.unverifiable_after_days - 1
  ) {
    due.push("extra_reminder");
  }

  // Still nothing: tell an administrator to telephone.
  if (
    awaitingCustomer &&
    !hasConfirmation &&
    !sent.has("admin_notified") &&
    awaitingCustomerDays !== null &&
    awaitingCustomerDays >= settings.unverifiable_after_days
  ) {
    due.push("admin_notified");
  }

  return due;
}

function customerLinkUrl(path, token) {
  const base = (env.FRONTEND_BASE_URL || env.CORS_ORIGIN || "").split(",")[0].trim();
  // Fragment, not query string: the server logs full URLs, and a token in the
  // query would be written into the access log.
  const suffix = `${path}#t=${token}`;
  return base ? `${base.replace(/\/$/, "")}${suffix}` : suffix;
}

/**
 * Mints the customer's completion-confirmation link and emails it.
 *
 * No verification code: the four options are not a financial commitment, and a
 * second step measurably reduces the response rate -- which would push more
 * jobs into the telephone queue, the exact cost this is meant to avoid.
 */
async function sendCustomerConfirmationRequest(job, businessName) {
  if (!job.customer_email) return { sent: false, reason: "no_customer_email" };

  await revokeLinksForSubject("job", job.id, "completion_confirmation");

  const link = await createSecureLink({
    purpose: "completion_confirmation",
    subjectType: "job",
    subjectId: job.id,
    expertId: job.expert_id,
    recipientEmail: job.customer_email,
    expiresInDays: 60,
    requireCode: false,
  });

  const url = customerLinkUrl("/confirm-completion", link.token);

  const delivery = await sendMail({
    to: job.customer_email,
    subject: `Was your work with ${businessName} completed?`,
    text: `${businessName} has marked "${job.job_name}" as completed. Please confirm whether the work was done: ${url}`,
    html: `
      <p><strong>${businessName}</strong> has marked <strong>${job.job_name}</strong> as completed.</p>
      <p>Please let us know how it went. It takes a moment and helps us keep the platform honest.</p>
      <p><a href="${url}" style="display:inline-block;padding:13px 22px;background:#1B2C52;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">Confirm the work</a></p>
      <p style="color:#6B7280;font-size:13px;">If the work was not done, or not done properly, say so here — we will look into it.</p>`,
  });

  return { sent: delivery.sent, url };
}

/** The scheduler handler. */
async function runJobMonitoring() {
  const supabase = requireSupabase();
  const settings = await monitoring.getSettings();
  if (!settings.installed) return null;

  const { data: jobs, error } = await supabase
    .from("jobs")
    .select(
      "id, expert_id, reference, job_name, customer_name, customer_email, status, expected_completion_date, actual_completion_date",
    )
    .in("status", [...monitoring.OPEN_STATUSES, monitoring.AWAITING_CUSTOMER])
    .limit(BATCH_LIMIT);

  if (error) {
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) return null;
    throw new Error(`could not read jobs: ${error.message}`);
  }
  if (!jobs || jobs.length === 0) return null;

  const jobIds = jobs.map((job) => job.id);
  const expertIds = [...new Set(jobs.map((job) => job.expert_id))];

  const [eventsResult, confirmationsResult, expertsResult] = await Promise.all([
    supabase.from("job_monitoring_events").select("job_id, event_type").in("job_id", jobIds),
    supabase.from("job_completion_confirmations").select("job_id").in("job_id", jobIds),
    supabase.from("experts").select("expert_id, name, business_name, business_email").in("expert_id", expertIds),
  ]);

  const sentByJob = new Map();
  for (const event of eventsResult.data || []) {
    if (!sentByJob.has(event.job_id)) sentByJob.set(event.job_id, []);
    sentByJob.get(event.job_id).push(event.event_type);
  }
  const confirmed = new Set((confirmationsResult.data || []).map((c) => c.job_id));
  const expertsById = new Map((expertsResult.data || []).map((e) => [e.expert_id, e]));

  const adminEmail = env.MAIL_FROM || env.SMTP_USER;
  let sentCount = 0;
  const breakdown = {};

  for (const job of jobs) {
    const expert = expertsById.get(job.expert_id);
    const businessName = expert?.business_name || expert?.name || "your provider";
    const providerEmail = expert?.business_email;

    const notices = decideNotices({
      status: job.status,
      days: monitoring.daysFromExpected(job.expected_completion_date),
      alreadySent: sentByJob.get(job.id) || [],
      settings,
      awaitingCustomerDays: job.actual_completion_date
        ? monitoring.daysFromExpected(job.actual_completion_date)
        : null,
      hasConfirmation: confirmed.has(job.id),
    });

    for (const notice of notices) {
      // Marked before sending: a failed send costs one notice, where the
      // reverse order would re-send every hour after a crash.
      const recorded = await monitoring.recordEvent(job.id, notice, {
        sentTo: notice === "admin_notified" || notice === "escalated" ? adminEmail : providerEmail,
      });
      if (!recorded.sent) continue;

      const due = formatDate(job.expected_completion_date);
      let to = providerEmail;
      let subject = "";
      let body = "";

      if (notice === "provider_reminder") {
        subject = `${job.reference} is due on ${due}`;
        body = `<p><strong>${job.job_name}</strong> for ${job.customer_name} is due to be completed on <strong>${due}</strong>.</p>`;
      } else if (notice === "completion_request") {
        subject = `Is ${job.reference} complete?`;
        body = `<p><strong>${job.job_name}</strong> for ${job.customer_name} was due on <strong>${due}</strong>. If it is finished, mark it complete in your Jobs page so the customer can confirm.</p>`;
      } else if (notice === "overdue_reminder") {
        subject = `${job.reference} is overdue`;
        body = `<p><strong>${job.job_name}</strong> for ${job.customer_name} was due on <strong>${due}</strong> and is not yet marked complete. Update it, or request a new date with a reason.</p>`;
      } else if (notice === "extra_reminder") {
        // Goes to the customer, not the provider: the provider has done their
        // part and is waiting on an answer.
        to = job.customer_email;
        subject = `Reminder: was your work with ${businessName} completed?`;
        body = `<p>We asked whether <strong>${job.job_name}</strong> was completed and have not heard back. If you have a moment, please use the link in our earlier email — otherwise someone will telephone you.</p>`;
      } else if (notice === "admin_notified") {
        to = adminEmail;
        subject = `Action needed: ${job.reference}`;
        body =
          job.status === monitoring.AWAITING_CUSTOMER
            ? `<p><strong>${job.job_name}</strong> (${businessName}) was reported complete and the customer has not confirmed. Telephone ${job.customer_name} to verify.</p>`
            : `<p><strong>${job.job_name}</strong> (${businessName}) was due on <strong>${due}</strong> and is still open. The provider has been reminded.</p>`;
      } else if (notice === "escalated") {
        to = adminEmail;
        subject = `Escalation: ${job.reference} is well overdue`;
        body = `<p><strong>${job.job_name}</strong> (${businessName}) was due on <strong>${due}</strong> and remains open despite reminders.</p>`;
      }

      if (to && subject) {
        await sendMail({ to, subject, text: body.replace(/<[^>]+>/g, ""), html: body });
        sentCount += 1;
        breakdown[notice] = (breakdown[notice] || 0) + 1;
      }
    }
  }

  if (sentCount === 0) return null;
  const summary = Object.entries(breakdown).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ");
  return `${sentCount} notice(s): ${summary}`;
}

module.exports = {
  decideNotices,
  sendCustomerConfirmationRequest,
  runJobMonitoring,
};
