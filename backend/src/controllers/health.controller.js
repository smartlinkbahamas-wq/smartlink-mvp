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

module.exports = {
  getHealth,
  getMailHealth,
};

