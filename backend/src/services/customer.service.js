const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Customer records.
 *
 * A provider's own customer list: created automatically when they accept a
 * SmartLink introduction, and usable for customers obtained elsewhere so they
 * can manage their whole book in one place rather than keeping two lists.
 *
 * Email is the primary identifier, which is what prevents the same person
 * appearing three times. Only name, email and telephone are held -- no
 * extended KYC, because there is no need for it and collecting it would create
 * an obligation to protect it.
 */

const NOT_INSTALLED = "Customer records are not set up yet. Run sql/install_customers.sql.";

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "customers_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

function normaliseEmail(email) {
  const trimmed = String(email || "").trim().toLowerCase();
  return trimmed || null;
}

async function listCustomers(expertId, { includeArchived = false, search = null } = {}) {
  const supabase = requireSupabase();

  let query = supabase
    .from("customers")
    .select("*")
    .eq("expert_id", expertId)
    .order("full_name", { ascending: true });

  if (!includeArchived) query = query.eq("is_archived", false);
  if (search) {
    const term = `%${String(search).trim()}%`;
    query = query.or(`full_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`);
  }

  const { data, error } = await query;
  if (error) guard(error, "Could not load your customers.");
  return data || [];
}

async function getCustomer(expertId, customerId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that customer.");
  if (!data) {
    throw new AppError("That customer could not be found.", 404, { code: "customer_not_found" });
  }
  return data;
}

async function createCustomer(expertId, payload) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("customers")
    .insert({
      expert_id: expertId,
      full_name: String(payload.fullName).trim(),
      email: normaliseEmail(payload.email),
      phone: payload.phone?.trim() || null,
      notes: payload.notes?.trim() || null,
      // Forced: a provider adding a record by hand did not get that customer
      // from the platform, and letting the client declare otherwise would
      // corrupt every conversion figure that reads this field.
      source: "provider_entered",
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("You already have a customer with that email address.", 409, {
        code: "duplicate_customer_email",
      });
    }
    if (error.code === "23503") {
      throw new AppError("No provider profile is linked to this account.", 403, {
        code: "expert_profile_not_linked",
      });
    }
    guard(error, "Could not add that customer.");
  }

  return data;
}

async function updateCustomer(expertId, customerId, payload) {
  const supabase = requireSupabase();

  const update = {
    full_name: String(payload.fullName).trim(),
    email: normaliseEmail(payload.email),
    phone: payload.phone?.trim() || null,
    notes: payload.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (payload.isArchived !== undefined) update.is_archived = Boolean(payload.isArchived);

  const { data, error } = await supabase
    .from("customers")
    .update(update)
    .eq("id", customerId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("Another of your customers already uses that email address.", 409, {
        code: "duplicate_customer_email",
      });
    }
    guard(error, "Could not save that customer.");
  }
  if (!data) {
    throw new AppError("That customer could not be found.", 404, { code: "customer_not_found" });
  }

  // Note for anyone extending this: documents deliberately keep their own copy
  // of the customer's name and email. Editing a customer here does NOT rewrite
  // a quotation or invoice already sent, and must not.
  return data;
}

/**
 * Retires a customer rather than deleting them.
 *
 * A hard delete would orphan any quotation, invoice or job that references
 * them. Those documents carry their own copy of the customer details, so the
 * history survives either way -- but the link back would be lost, and a
 * provider who archived someone by mistake could not undo it.
 */
async function archiveCustomer(expertId, customerId, archived = true) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("customers")
    .update({ is_archived: Boolean(archived), updated_at: new Date().toISOString() })
    .eq("id", customerId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not update that customer.");
  if (!data) {
    throw new AppError("That customer could not be found.", 404, { code: "customer_not_found" });
  }
  return data;
}

/**
 * Creates or finds the customer behind an accepted introduction.
 *
 * NEVER THROWS. This runs inside the accept-opportunity path, and a provider
 * accepting work must not fail because a bookkeeping record could not be
 * written. A missing customer row is recoverable; a failed acceptance is not.
 *
 * Returns the customer id, or null if nothing could be created.
 */
async function findOrCreateFromLead(expertId, leadId, introductionRequestId = null) {
  if (!expertId || !leadId) return null;

  try {
    const supabase = requireSupabase();

    const { data: lead, error: leadError } = await supabase
      .from("lead_submissions")
      .select("id, full_name, work_email, phone_number")
      .eq("id", leadId)
      .maybeSingle();

    if (leadError || !lead) return null;

    const email = normaliseEmail(lead.work_email);
    const fullName = String(lead.full_name || "").trim();
    if (!fullName) return null;

    if (email) {
      // Matched on the normalised address, which is what the unique index uses,
      // so this finds the row a second insert would collide with.
      const { data: existing } = await supabase
        .from("customers")
        .select("id")
        .eq("expert_id", expertId)
        .ilike("email", email)
        .maybeSingle();

      if (existing) return existing.id;
    }

    const { data: created, error: insertError } = await supabase
      .from("customers")
      .insert({
        expert_id: expertId,
        full_name: fullName,
        email,
        phone: lead.phone_number?.trim() || null,
        source: "smartlink",
        first_lead_id: leadId,
        first_introduction_request_id: introductionRequestId,
      })
      .select("id")
      .single();

    if (insertError) {
      // Two accepts racing for the same customer: one wins the unique index and
      // the other lands here. The row exists, which is the desired outcome, so
      // this reads it rather than treating it as a failure.
      if (insertError.code === "23505" && email) {
        const { data: existing } = await supabase
          .from("customers")
          .select("id")
          .eq("expert_id", expertId)
          .ilike("email", email)
          .maybeSingle();
        return existing?.id || null;
      }
      console.warn("[customers] could not create from lead:", insertError.message);
      return null;
    }

    return created.id;
  } catch (error) {
    console.warn("[customers] findOrCreateFromLead failed:", error.message);
    return null;
  }
}

/**
 * Everything this provider has done with this customer.
 *
 * Each query is scoped by expert_id as well as customer_id. Scoping by
 * customer alone would be enough today because customers are per provider, but
 * it would stop being enough the moment customers are ever shared, and the
 * cost of the extra predicate is nothing.
 */
async function getCustomerHistory(expertId, customerId) {
  await getCustomer(expertId, customerId); // ownership check

  const supabase = requireSupabase();

  const [quotations, invoices, jobs] = await Promise.all([
    supabase
      .from("quotations")
      .select("id, reference, job_name, total, currency, status, valid_until, created_at")
      .eq("expert_id", expertId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, reference, job_name, total, currency, status, due_date, created_at")
      .eq("expert_id", expertId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, reference, job_name, status, agreed_price, currency, expected_completion_date, created_at")
      .eq("expert_id", expertId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
  ]);

  // One section failing degrades that section only. A provider looking at a
  // customer is better served by two of three lists than by an error page.
  for (const [label, result] of [["quotations", quotations], ["invoices", invoices], ["jobs", jobs]]) {
    if (result.error && !tableIsMissing(result.error)) {
      console.warn(`[customers] could not load ${label}:`, result.error.message);
    }
  }

  return {
    quotations: quotations.data || [],
    invoices: invoices.data || [],
    jobs: jobs.data || [],
  };
}

/**
 * Folds one customer record into another.
 *
 * The unique index already prevents two records with the same address, so a
 * duplicate pair can only exist where one of them has no email -- a walk-in
 * added by hand who later came through the platform, for instance. This is the
 * manual resolution for that case.
 *
 * Documents are repointed rather than rewritten: their stored name and email
 * stay exactly as they were sent.
 */
async function mergeCustomers(expertId, keepId, mergeId) {
  if (keepId === mergeId) {
    throw new AppError("Choose two different customers to merge.", 400, { code: "merge_same_customer" });
  }

  const keep = await getCustomer(expertId, keepId);
  const merge = await getCustomer(expertId, mergeId);

  const supabase = requireSupabase();

  for (const table of ["quotations", "invoices", "jobs"]) {
    const { error } = await supabase
      .from(table)
      .update({ customer_id: keepId })
      .eq("expert_id", expertId)
      .eq("customer_id", mergeId);

    if (error && !tableIsMissing(error)) {
      throw new AppError(`Could not move ${table} to the kept customer.`, 500, error.message);
    }
  }

  // Fill gaps on the surviving record from the one being folded in, so merging
  // never loses a phone number the other row had.
  const patch = { updated_at: new Date().toISOString() };
  if (!keep.email && merge.email) patch.email = merge.email;
  if (!keep.phone && merge.phone) patch.phone = merge.phone;
  if (merge.notes) patch.notes = [keep.notes, merge.notes].filter(Boolean).join("\n---\n");
  if (keep.source === "provider_entered" && merge.source === "smartlink") {
    // The customer did come from the platform; the provider simply recorded
    // them first. Attribution follows the truth.
    patch.source = "smartlink";
    patch.first_lead_id = merge.first_lead_id;
    patch.first_introduction_request_id = merge.first_introduction_request_id;
  }

  const { data: updated, error: updateError } = await supabase
    .from("customers")
    .update(patch)
    .eq("id", keepId)
    .eq("expert_id", expertId)
    .select("*")
    .single();

  if (updateError) guard(updateError, "Could not merge those customers.");

  const { error: deleteError } = await supabase
    .from("customers")
    .delete()
    .eq("id", mergeId)
    .eq("expert_id", expertId);

  if (deleteError) {
    // The merge already succeeded; only the tidy-up failed. Archived instead,
    // so the duplicate stops appearing without losing the work.
    console.warn("[customers] merged but could not delete duplicate:", deleteError.message);
    await archiveCustomer(expertId, mergeId, true);
  }

  return updated;
}


/**
 * Links a document to a customer, creating the record if there is none.
 *
 * Used when a provider raises a quotation or enters a job: the person they are
 * quoting becomes a customer, which is how the list fills up through ordinary
 * work rather than requiring separate data entry.
 *
 * NEVER THROWS, for the same reason as findOrCreateFromLead -- a quotation must
 * not fail because a customer row could not be written.
 */
async function findOrCreateForDocument(expertId, { email, fullName, phone, leadId = null, introductionRequestId = null }) {
  if (!expertId) return null;

  const normalised = normaliseEmail(email);
  const name = String(fullName || "").trim();
  if (!normalised && !name) return null;

  try {
    const supabase = requireSupabase();

    if (normalised) {
      const { data: existing } = await supabase
        .from("customers")
        .select("id")
        .eq("expert_id", expertId)
        .ilike("email", normalised)
        .maybeSingle();

      if (existing) return existing.id;
    }

    if (!name) return null;

    const { data: created, error } = await supabase
      .from("customers")
      .insert({
        expert_id: expertId,
        full_name: name,
        email: normalised,
        phone: phone?.trim() || null,
        // A document raised against a SmartLink lead reflects a customer the
        // platform produced; one raised without a lead does not.
        source: leadId ? "smartlink" : "provider_entered",
        first_lead_id: leadId,
        first_introduction_request_id: introductionRequestId,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505" && normalised) {
        const { data: existing } = await supabase
          .from("customers")
          .select("id")
          .eq("expert_id", expertId)
          .ilike("email", normalised)
          .maybeSingle();
        return existing?.id || null;
      }
      console.warn("[customers] could not create for document:", error.message);
      return null;
    }

    return created.id;
  } catch (error) {
    console.warn("[customers] findOrCreateForDocument failed:", error.message);
    return null;
  }
}

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  archiveCustomer,
  findOrCreateFromLead,
  findOrCreateForDocument,
  getCustomerHistory,
  mergeCustomers,
};
