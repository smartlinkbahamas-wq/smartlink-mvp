const { requireSupabase } = require("../utils/supabase-guard");

/**
 * The append-only record of every stage an inquiry passes through.
 *
 * introduction_requests.status is overwritten on each change and the row has
 * only created_at, so stage-to-stage timing is otherwise uncomputable. Every
 * transition writes a row here; the status column stays as a cache of the
 * latest one.
 *
 * Recording a stage must never fail the action that caused it — a provider
 * accepting an opportunity should not see an error because the audit write
 * had a problem. So this module follows the mail-service contract: it never
 * throws, and returns a result the caller can log.
 */

const SUBJECT_TYPES = {
  INTRODUCTION_REQUEST: "introduction_request",
};

const ACTOR_TYPES = {
  EXPERT: "expert",
  CUSTOMER: "customer",
  ADMIN: "admin",
  SYSTEM: "system",
};

async function recordStageEvent({
  subjectType,
  subjectId,
  expertId = null,
  leadId = null,
  fromStage = null,
  toStage,
  actorType = ACTOR_TYPES.SYSTEM,
  actorUserId = null,
  notes = null,
  source = "smartlink",
}) {
  if (!subjectType || !subjectId || !toStage) {
    console.warn("[pipeline] skipped stage event: subjectType, subjectId and toStage are all required");
    return { recorded: false, reason: "missing_required_fields" };
  }

  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from("pipeline_stage_events")
      .insert({
        subject_type: subjectType,
        subject_id: subjectId,
        expert_id: expertId,
        lead_id: leadId,
        from_stage: fromStage,
        to_stage: toStage,
        actor_type: actorType,
        actor_user_id: actorUserId,
        notes,
        source,
      })
      .select("id")
      .single();

    if (error) {
      // 42P01 is "relation does not exist" — the install SQL has not been run
      // yet. Say so once, clearly, rather than failing the caller.
      if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
        console.warn(
          "[pipeline] pipeline_stage_events is missing — run sql/install_pipeline_stage_events.sql. Stage history is not being recorded.",
        );
        return { recorded: false, reason: "table_missing" };
      }
      console.error(`[pipeline] failed to record ${toStage} for ${subjectType} ${subjectId}:`, error.message);
      return { recorded: false, reason: error.message };
    }

    return { recorded: true, eventId: data.id };
  } catch (error) {
    console.error(`[pipeline] failed to record ${toStage}:`, error.message);
    return { recorded: false, reason: error.message };
  }
}

/**
 * Stage history for one subject, oldest first. Returns [] rather than
 * throwing when the table is absent, so a caller can render an empty
 * timeline instead of an error.
 */
async function listStageHistory(subjectType, subjectId) {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from("pipeline_stage_events")
      .select("id, from_stage, to_stage, actor_type, actor_user_id, notes, source, created_at")
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.code === "42P01" || /schema cache/i.test(error.message || "")) return [];
      console.error("[pipeline] failed to read stage history:", error.message);
      return [];
    }
    return data || [];
  } catch (error) {
    console.error("[pipeline] failed to read stage history:", error.message);
    return [];
  }
}

/**
 * Counts per stage, for the conversion reporting.
 *
 * Counts DISTINCT subjects, not events: a subject that reached a stage,
 * moved on, and came back must not be counted twice. The previous admin
 * conversion figure was wrong for a related reason — it divided accepted
 * introductions by total leads, two different units — so every consumer of
 * this gets the denominator alongside the number rather than a bare
 * percentage.
 */
async function getStageCounts({ subjectType, source = null, since = null } = {}) {
  try {
    const supabase = requireSupabase();
    let query = supabase
      .from("pipeline_stage_events")
      .select("subject_id, to_stage, source, created_at");

    if (subjectType) query = query.eq("subject_type", subjectType);
    if (source) query = query.eq("source", source);
    if (since) query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) {
      if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
        return { available: false, counts: {}, reason: "table_missing" };
      }
      console.error("[pipeline] failed to read stage counts:", error.message);
      return { available: false, counts: {}, reason: error.message };
    }

    const seen = new Map();
    (data || []).forEach((row) => {
      if (!seen.has(row.to_stage)) seen.set(row.to_stage, new Set());
      seen.get(row.to_stage).add(row.subject_id);
    });

    const counts = {};
    for (const [stage, subjects] of seen.entries()) counts[stage] = subjects.size;

    return { available: true, counts };
  } catch (error) {
    console.error("[pipeline] failed to read stage counts:", error.message);
    return { available: false, counts: {}, reason: error.message };
  }
}

module.exports = {
  SUBJECT_TYPES,
  ACTOR_TYPES,
  recordStageEvent,
  listStageHistory,
  getStageCounts,
};
