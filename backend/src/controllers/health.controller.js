const { getEnvSummary } = require("../config/env");
const { isSupabaseConfigured } = require("../config/supabase");

function getHealth(req, res) { // eslint-disable-line no-unused-vars
  res.json({
    success: true,
    message: "Backend is healthy.",
    data: {
      timestamp: new Date().toISOString(),
      env: getEnvSummary(),
      supabaseConfigured: isSupabaseConfigured,
    },
  });
}

// Confirms the SMTP credentials actually work, without sending anything.
async function getMailHealth(req, res) {
  const { verifyMailConnection } = require("../services/mail.service");
  const result = await verifyMailConnection();
  return res.status(result.ok ? 200 : 503).json({ success: result.ok, data: result });
}


/**
 * Whether timed work is actually running.
 *
 * Reports each task's last result and what it did, because "is the scheduler
 * working" is answered by "3 reminders sent at 14:02", not by an uptime figure.
 */
async function getSchedulerHealth(req, res) {
  const { getStatus } = require("../services/scheduler.service");
  const status = await getStatus();
  return res.json({ success: true, data: status });
}

module.exports = {
  getSchedulerHealth,
  getHealth,
  getMailHealth,
};

