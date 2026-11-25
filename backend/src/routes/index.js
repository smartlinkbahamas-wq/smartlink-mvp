const express = require("express");

const { healthRouter } = require("./health.routes");
const { leadTrustRouter } = require("./lead-trust.routes");
const { serviceMenuRouter } = require("./service-menu.routes");
const { businessHubRouter, customerDocumentRouter } = require("./business-hub.routes");
const { customerRouter } = require("./customer.routes");
const { calendarRouter } = require("./calendar.routes");
const { jobConfirmationRouter, jobMonitoringAdminRouter } = require("./job-monitoring.routes");
const { leadRouter } = require("./lead.routes");
const { matchesRouter } = require("./matches.routes");
const { introductionRouter } = require("./introduction.routes");
const { feedbackRouter } = require("./feedback.routes");
const { reviewsRouter } = require("./reviews.routes");
const { adminRouter } = require("./admin.routes");
const { expertsRouter } = require("./experts.routes");
const { authRouter } = require("./auth.routes");
const { clientRouter } = require("./client.routes");
const { categoryRouter } = require("./category.routes");

const apiRouter = express.Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/trust", leadTrustRouter);
apiRouter.use("/service-menu", serviceMenuRouter);
apiRouter.use("/hub", businessHubRouter);
apiRouter.use("/customers", customerRouter);
apiRouter.use("/calendar", calendarRouter);
apiRouter.use("/confirm-completion", jobConfirmationRouter);
apiRouter.use("/admin/job-monitoring", jobMonitoringAdminRouter);
apiRouter.use("/documents", customerDocumentRouter);
apiRouter.use("/leads", leadRouter);
apiRouter.use("/matches", matchesRouter);
apiRouter.use("/introduction-requests", introductionRouter);
apiRouter.use("/feedback", feedbackRouter);
apiRouter.use("/reviews", reviewsRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/experts", expertsRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/client", clientRouter);
apiRouter.use("/categories", categoryRouter);

module.exports = {
  apiRouter,
};
