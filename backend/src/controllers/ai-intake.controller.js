const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const ai = require("../services/ai-intake.service");
const { trackMetricEvent } = require("../services/metrics.service");

/**
 * The catalogue arrives from the browser, so it is attacker-controlled.
 *
 * Bounds matter here for cost rather than correctness: an unbounded option
 * list would let anyone build an enormous prompt and burn the free tier in a
 * handful of requests.
 */
const optionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
});

const catalogueSchema = z.object({
  audiences: z.array(optionSchema).min(1).max(10),
  categories: z.array(optionSchema).min(1).max(60),
  urgency: z.array(optionSchema).max(20),
  budget: z.array(optionSchema).max(20),
  location: z.array(optionSchema).max(30),
});

const requestSchema = z.object({
  // Long enough for a real description, short enough that the prompt stays
  // cheap. Two characters is not a description worth a model call.
  description: z.string().trim().min(10, "Tell us a little more.").max(1500),
  catalogue: catalogueSchema,
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

/**
 * Always returns 200.
 *
 * A failure is not an error to the customer: they continue to the
 * questionnaire with their text intact. Returning a 4xx or 5xx would make the
 * browser treat a recoverable situation as a dead end, and a dead end here
 * loses the lead entirely.
 */
async function postSuggest(req, res) {
  const payload = parse(requestSchema, req.body, "Tell us a little more about what you need.");

  const started = Date.now();
  const result = await ai.suggestFromDescription(payload.description, payload.catalogue);
  const durationMs = Date.now() - started;

  // Counts and reasons only. The customer's text is never recorded: people
  // type legal, debt and medical circumstances into this box.
  trackMetricEvent("ai_intake", {
    ok: result.ok,
    reason: result.reason || null,
    durationMs,
    droppedFields: result.dropped?.length || 0,
    confidence: result.suggestion?.confidence ?? null,
  });

  if (!result.ok) {
    return res.json({
      success: true,
      data: {
        available: false,
        reason: result.reason,
        // The frontend shows the questionnaire. It never shows this text.
        message: "We could not read that automatically. The questions work just as well.",
      },
    });
  }

  return res.json({
    success: true,
    data: {
      available: true,
      suggestion: result.suggestion,
      // Surfaced so the frontend can say "we could not place that bit" rather
      // than silently ignoring part of what the customer wrote.
      dropped: result.dropped,
    },
  });
}

async function getAiHealth(req, res) {
  return res.json({ success: true, data: ai.getStatus() });
}

module.exports = {
  postSuggest,
  getAiHealth,
};
