const { AppError } = require("../utils/app-error");
const { env } = require("../config/env");

/**
 * "Describe What You Need": a free-text route into the existing questionnaire.
 *
 * What this does NOT do, deliberately:
 *
 * - It does not change matching. The AI fills in answers, the customer
 *   confirms them, and the existing engine runs on the existing shape.
 * - It does not replace the questionnaire, which stays available and is also
 *   where every failure lands.
 * - It does not answer the route-specific follow-up questions. Those carry
 *   riskPoints that feed lead pricing, so a guess there moves money a provider
 *   pays. It fills the category and only those of urgency, budget and location
 *   the customer actually stated.
 *
 * THE MODEL RETURNS OPTION IDS, NEVER PROSE. The ids are constrained by an
 * enum built from the catalogue the frontend sends, and then re-validated here
 * against that same catalogue. Both steps are necessary: the schema makes
 * valid output likely, and the validation makes invalid output harmless.
 *
 * An unvalidated id is worse than no answer. getSelectedOption returns
 * undefined for an unknown id and contributes zero risk points, so a bad id
 * produces a lead that looks answered, scores zero, and silently omits itself
 * from the responses array.
 *
 * The provider sits behind one module and one env var. Switching from Gemini
 * is a config change plus one adapter.
 */

const MODEL = "gemini-2.0-flash";
const TIMEOUT_MS = 8000;

// Per process and in memory, like the rate limiters. Reset on deploy, which is
// acceptable: this is a cost ceiling, not a security control.
const callCounts = { day: null, used: 0 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dailyLimit() {
  // The free tier allowance divided by the number of instances, so N servers
  // cannot together exceed what one allowance covers.
  const instances = Math.max(1, env.AI_INSTANCE_COUNT || 1);
  return Math.floor((env.AI_DAILY_CALL_LIMIT || 1200) / instances);
}

function remainingToday() {
  if (callCounts.day !== today()) return dailyLimit();
  return Math.max(0, dailyLimit() - callCounts.used);
}

function recordCall() {
  const day = today();
  if (callCounts.day !== day) {
    callCounts.day = day;
    callCounts.used = 0;
  }
  callCounts.used += 1;
}

function isConfigured() {
  return Boolean(env.GEMINI_API_KEY);
}

/**
 * Builds the instruction and the response schema from the catalogue the
 * frontend sent.
 *
 * The frontend owns the vocabulary. There is no copy of the question catalogue
 * on the server: the quiz's categories are partly administrator-managed and
 * live only in Postgres, and a second copy here would drift from the first.
 */
function buildRequest(description, catalogue) {
  const audienceIds = catalogue.audiences.map((a) => a.id);
  const categoryIds = catalogue.categories.map((c) => c.id);
  const urgencyIds = catalogue.urgency.map((o) => o.id);
  const budgetIds = catalogue.budget.map((o) => o.id);
  const locationIds = catalogue.location.map((o) => o.id);

  const describe = (items) =>
    items.map((item) => `  ${item.id} = ${item.label}`).join("\n");

  const instruction = [
    "You are helping someone in The Bahamas describe what service they need.",
    "They have written a short description. Map it onto the options below.",
    "",
    "Rules:",
    "1. Return option IDs exactly as written. Never invent an id.",
    "2. Only fill urgency, budget or location if the person actually said",
    "   something that implies it. If they did not mention it, omit the field.",
    "   Guessing is worse than leaving it for them to answer.",
    "3. Pick the single closest category. If nothing fits well, omit it.",
    "4. confidence is how sure you are about the category, 0 to 1.",
    "",
    "AUDIENCE (is this for a business or themselves?):",
    describe(catalogue.audiences),
    "",
    "CATEGORY (what kind of help):",
    describe(catalogue.categories),
    "",
    "URGENCY (only if stated):",
    describe(catalogue.urgency),
    "",
    "BUDGET (only if stated):",
    describe(catalogue.budget),
    "",
    "LOCATION (only if stated):",
    describe(catalogue.location),
    "",
    "What they wrote:",
    description,
  ].join("\n");

  // enum constrains the model to ids that exist. It is the first of two
  // defences; validateSuggestion is the second.
  const responseSchema = {
    type: "object",
    properties: {
      audience: { type: "string", enum: audienceIds },
      category: { type: "string", enum: categoryIds },
      urgency: { type: "string", enum: urgencyIds },
      budget: { type: "string", enum: budgetIds },
      location: { type: "string", enum: locationIds },
      confidence: { type: "number" },
    },
    required: ["audience"],
  };

  return { instruction, responseSchema };
}

/**
 * Re-checks every id against the catalogue.
 *
 * Mandatory, not defensive. An id that does not exist produces a lead that
 * looks answered and scores nothing, which is harder to notice than an error.
 */
function validateSuggestion(raw, catalogue) {
  const pick = (value, items) => {
    if (!value) return null;
    const match = items.find((item) => item.id === value);
    return match ? match.id : null;
  };

  const validated = {
    audience: pick(raw.audience, catalogue.audiences),
    category: pick(raw.category, catalogue.categories),
    urgency: pick(raw.urgency, catalogue.urgency),
    budget: pick(raw.budget, catalogue.budget),
    location: pick(raw.location, catalogue.location),
    confidence:
      typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
        ? Number(raw.confidence.toFixed(2))
        : null,
  };

  const dropped = ["audience", "category", "urgency", "budget", "location"].filter(
    (key) => raw[key] && !validated[key],
  );

  return { validated, dropped };
}

/**
 * Calls Gemini.
 *
 * Wrapped so the rest of the service never sees a provider-specific shape.
 * Any failure here is a fallback, not an error: the customer continues to the
 * questionnaire with their text carried over.
 */
async function callGemini(instruction, responseSchema) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instruction }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.1,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const status = response.status;
      // 429 is the free tier running out, which is expected rather than
      // exceptional and is reported as such.
      throw new Error(status === 429 ? "rate_limited" : `provider_error_${status}`);
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("empty_response");

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole feature.
 *
 * NEVER THROWS for a provider problem. Every failure returns
 * { ok: false, reason } and the caller sends the customer to the questionnaire
 * with their text intact. A dead end here loses the lead entirely, which costs
 * far more than a missed convenience.
 */
async function suggestFromDescription(description, catalogue) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  if (remainingToday() <= 0) {
    return { ok: false, reason: "daily_limit_reached" };
  }

  const { instruction, responseSchema } = buildRequest(description, catalogue);

  try {
    recordCall();
    const raw = await callGemini(instruction, responseSchema);
    const { validated, dropped } = validateSuggestion(raw, catalogue);

    // Nothing usable came back. Treated as a failure rather than returning an
    // empty confirmation card that wastes the customer's time.
    if (!validated.audience && !validated.category) {
      return { ok: false, reason: "no_usable_suggestion", dropped };
    }

    return { ok: true, suggestion: validated, dropped };
  } catch (error) {
    const reason =
      error.name === "AbortError"
        ? "timeout"
        : error.message === "rate_limited"
          ? "rate_limited"
          : error.message === "empty_response"
            ? "empty_response"
            : error instanceof SyntaxError
              ? "unparseable"
              : "provider_error";

    // The customer's text is NEVER logged. People type legal, debt and medical
    // circumstances into this box.
    console.warn(`[ai-intake] suggestion failed: ${reason}`);
    return { ok: false, reason };
  }
}

/** For /api/health/ai. Reports state, never the key. */
function getStatus() {
  return {
    configured: isConfigured(),
    provider: "gemini",
    model: MODEL,
    dailyLimit: dailyLimit(),
    usedToday: callCounts.day === today() ? callCounts.used : 0,
    remainingToday: remainingToday(),
    timeoutMs: TIMEOUT_MS,
  };
}

module.exports = {
  MODEL,
  isConfigured,
  buildRequest,
  validateSuggestion,
  suggestFromDescription,
  getStatus,
  // Exported for tests only.
  _resetCounts: () => {
    callCounts.day = null;
    callCounts.used = 0;
  },
};
