const { resolveExpertIdForUser } = require("../utils/expert-identity");
const reporting = require("../services/reporting.service");

/**
 * Two reports, two audiences, two very different confidentiality rules.
 *
 * A provider sees their own cost and profit, because it is their business. An
 * administrator never does -- getAdminReport does not query the table those
 * figures live in, so there is nothing to strip.
 */

async function getMyReport(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const report = await reporting.getProviderReport(expertId);
  return res.json({ success: true, data: report });
}

async function getPlatformReport(req, res) {
  const report = await reporting.getAdminReport();
  return res.json({ success: true, data: report });
}

module.exports = {
  getMyReport,
  getPlatformReport,
};
