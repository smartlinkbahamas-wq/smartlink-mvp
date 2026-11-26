const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Support tickets and complaint handling.
 *
 * Two categories: platform support, and job-related complaints.
 *
 * This is not a helpdesk. No queues, no SLAs, no canned replies, no routing,
 * no load balancing. That boundary was set deliberately and holds.
 *
 * THE COMPLAINT RULE, which shapes most of this file:
 *
 *   An administrator reviews a complaint first. The provider receives an
 *   administrator-prepared SUMMARY, never the customer's original words. If
 *   the provider asks for the original, an administrator may share it after
 *   reviewing the request.
 *
 * That is enforced here by getTicketForProvider never selecting `body` at all.
 * Not stripped afterwards, not hidden in the interface -- simply not fetched,
 * so a mistake in a component cannot leak it.
 *
 * Two policy positions must also be visible in what the system does:
 * providers are not penalised on unverified complaints (nothing here writes to
 * any rating or score), and SmartLink documents disputes without assuming
 * responsibility for them (there is no adjudication field, only a record).
 */

const NOT_INSTALLED = "Support tickets are not set up yet. Run sql/install_support.sql.";

const TICKET_STATUSES = [
  "new",
  "under_review",
  "awaiting_customer",
  "awaiting_provider",
  "resolved",
  "closed",
];

const OPEN_STATUSES = ["new", "under_review", "awaiting_customer", "awaiting_provider"];

/**
 * The fields a provider may ever see.
 *
 * `body` is deliberately absent. Adding it here is the single change that
 * would break the complaint rule, which is why the list is explicit rather
 * than a spread with exclusions.
 */
const PROVIDER_TICKET_FIELDS =
  "id, reference, category, status, priority, subject, provider_summary, provider_summary_at, " +
  "original_requested_at, original_shared_at, job_id, expert_id, resolution, resolved_at, created_at, updated_at";

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "support_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

async function nextReference() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc("next_support_ticket_number");

  if (error) {
    if (tableIsMissing(error) || /function .* does not exist/i.test(error.message || "")) {
      throw new AppError(NOT_INSTALLED, 503, { code: "support_not_installed" });
    }
    throw new AppError("Could not allocate a ticket reference.", 500, error.message);
  }

  return `TKT-${String(data).padStart(4, "0")}`;
}

// --- Raising a ticket ------------------------------------------------------

async function createTicket(payload) {
  const supabase = requireSupabase();
  const reference = await nextReference();

  const { data, error } = await supabase
    .from("support_tickets")
    .insert({
      reference,
      category: payload.category,
      raised_by: payload.raisedBy,
      raised_by_user_id: payload.raisedByUserId || null,
      raised_by_email: payload.raisedByEmail?.trim().toLowerCase() || null,
      raised_by_name: payload.raisedByName?.trim() || null,
      job_id: payload.jobId || null,
      expert_id: payload.expertId || null,
      customer_id: payload.customerId || null,
      subject: String(payload.subject).trim(),
      body: String(payload.body).trim(),
      priority: payload.priority || "normal",
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not raise that ticket.");

  // The original text is also recorded as the first message, with visibility
  // matching who wrote it -- so a complaint's opening words are never visible
  // to the provider through the thread either.
  await supabase.from("support_ticket_messages").insert({
    ticket_id: data.id,
    author_type: payload.raisedBy,
    author_user_id: payload.raisedByUserId || null,
    author_name: payload.raisedByName || null,
    body: String(payload.body).trim(),
    visible_to: payload.raisedBy === "customer" ? "customer" : payload.raisedBy === "provider" ? "provider" : "internal",
  });

  return data;
}

// --- Administrator view ----------------------------------------------------

async function listTickets({ status = null, category = null } = {}) {
  const supabase = requireSupabase();

  let query = supabase.from("support_tickets").select("*").order("created_at", { ascending: false });
  if (status === "open") query = query.in("status", OPEN_STATUSES);
  else if (status) query = query.eq("status", status);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) guard(error, "Could not load the tickets.");
  return data || [];
}

/** Everything, including internal notes. Administrators only. */
async function getTicketForAdmin(ticketId) {
  const supabase = requireSupabase();

  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  if (error) guard(error, "Could not load that ticket.");
  if (!ticket) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }

  const { data: messages } = await supabase
    .from("support_ticket_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  return { ticket, messages: messages || [] };
}

// --- Provider view ---------------------------------------------------------

/**
 * A provider's own tickets.
 *
 * Selected with the explicit field list, so the customer's original words are
 * never fetched for a complaint. A provider sees the summary an administrator
 * wrote, and the original only once an administrator has decided to share it.
 */
async function listTicketsForProvider(expertId) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("support_tickets")
    .select(PROVIDER_TICKET_FIELDS)
    .eq("expert_id", expertId)
    // A complaint the administrator has not yet summarised is not shown at
    // all: the provider must not learn of it before the review happens.
    .or("category.eq.platform_support,provider_summary.not.is.null")
    .order("created_at", { ascending: false });

  if (error) guard(error, "Could not load your tickets.");
  return data || [];
}

async function getTicketForProvider(expertId, ticketId) {
  const supabase = requireSupabase();

  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .select(PROVIDER_TICKET_FIELDS)
    .eq("id", ticketId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that ticket.");
  if (!ticket) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }

  // A complaint with no summary yet is not readable by the provider, even
  // directly by id.
  if (ticket.category === "job_complaint" && !ticket.provider_summary) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }

  const { data: messages } = await supabase
    .from("support_ticket_messages")
    .select("id, author_type, author_name, body, visible_to, created_at")
    .eq("ticket_id", ticketId)
    .in("visible_to", ["provider", "all"])
    .order("created_at", { ascending: true });

  // The original is included only once an administrator has shared it, and
  // then as an explicit extra field rather than as `body` -- so nothing can
  // mistake "the original we chose to share" for "the ticket's contents".
  let originalComplaint = null;
  if (ticket.original_shared_at) {
    const { data: full } = await supabase
      .from("support_tickets")
      .select("body")
      .eq("id", ticketId)
      .maybeSingle();
    originalComplaint = full?.body || null;
  }

  return { ticket, messages: messages || [], originalComplaint };
}

// --- Messages --------------------------------------------------------------

async function addMessage(ticketId, { authorType, authorUserId, authorName, body, visibleTo }) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticketId,
      author_type: authorType,
      author_user_id: authorUserId || null,
      author_name: authorName || null,
      body: String(body).trim(),
      // Defaults to internal when unspecified. The safe direction: a note that
      // should have been shared is a nuisance, one that should not have been
      // is a breach.
      visible_to: visibleTo || "internal",
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not add that message.");

  await supabase
    .from("support_tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", ticketId);

  return data;
}

// --- The complaint workflow ------------------------------------------------

/**
 * Writes the summary the provider will see.
 *
 * This is the step that makes a complaint visible to the provider at all, and
 * it is deliberately a human act: nothing generates this automatically from
 * the customer's text, because the whole point is that an administrator has
 * read it and decided what the provider needs to know.
 */
async function setProviderSummary(ticketId, summary, adminUserId) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("support_tickets")
    .update({
      provider_summary: String(summary).trim(),
      provider_summary_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not save that summary.");
  if (!data) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }

  await addMessage(ticketId, {
    authorType: "administrator",
    authorUserId: adminUserId,
    body: String(summary).trim(),
    visibleTo: "provider",
  });

  return data;
}

/** The provider asks to see what was actually said. */
async function requestOriginal(expertId, ticketId) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("support_tickets")
    .update({ original_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", ticketId)
    .eq("expert_id", expertId)
    .is("original_requested_at", null)
    .select(PROVIDER_TICKET_FIELDS)
    .maybeSingle();

  if (error) guard(error, "Could not send that request.");
  if (!data) {
    // Either not theirs, or already requested. Both answer the same way, so a
    // provider cannot probe for tickets that are not theirs.
    throw new AppError(
      "That request could not be sent. It may already have been made.",
      409,
      { code: "request_not_sent" },
    );
  }

  return data;
}

/**
 * The administrator decides whether to share the original.
 *
 * Sharing is recorded with who decided and when. Declining is recorded as an
 * internal note rather than silently doing nothing, so the decision exists
 * either way.
 */
async function decideOriginalShare(ticketId, { share, reason, adminUserId }) {
  const supabase = requireSupabase();

  const { data: ticket, error: loadError } = await supabase
    .from("support_tickets")
    .select("id, original_requested_at, original_shared_at")
    .eq("id", ticketId)
    .maybeSingle();

  if (loadError) guard(loadError, "Could not load that ticket.");
  if (!ticket) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }
  if (!ticket.original_requested_at) {
    throw new AppError(
      "The provider has not asked to see the original, so there is nothing to decide.",
      409,
      { code: "no_request_to_decide" },
    );
  }

  if (!share) {
    await addMessage(ticketId, {
      authorType: "administrator",
      authorUserId: adminUserId,
      body: reason
        ? `Declined to share the original complaint. Reason: ${reason}`
        : "Declined to share the original complaint.",
      visibleTo: "internal",
    });
    return { shared: false };
  }

  const { data, error } = await supabase
    .from("support_tickets")
    .update({
      original_shared_at: new Date().toISOString(),
      original_share_decided_by: adminUserId || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .select("id, original_shared_at")
    .maybeSingle();

  if (error) guard(error, "Could not share the original.");

  await addMessage(ticketId, {
    authorType: "administrator",
    authorUserId: adminUserId,
    body: "The original complaint has been shared with the provider.",
    visibleTo: "internal",
  });

  return { shared: true, sharedAt: data.original_shared_at };
}

// --- Status ----------------------------------------------------------------

async function updateTicket(ticketId, { status, priority, assignedToUserId, resolution }, adminUserId) {
  if (status && !TICKET_STATUSES.includes(status)) {
    throw new AppError("That is not a valid status.", 400, { code: "invalid_status" });
  }

  const supabase = requireSupabase();
  const update = { updated_at: new Date().toISOString() };

  if (status) update.status = status;
  if (priority) update.priority = priority;
  if (assignedToUserId !== undefined) update.assigned_to_user_id = assignedToUserId;
  if (resolution !== undefined) update.resolution = resolution?.trim() || null;

  if (status === "resolved") update.resolved_at = new Date().toISOString();
  if (status === "closed") update.closed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("support_tickets")
    .update(update)
    .eq("id", ticketId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23514") {
      throw new AppError(
        "Record how the ticket was resolved before resolving or closing it.",
        400,
        { code: "resolution_required" },
      );
    }
    guard(error, "Could not update that ticket.");
  }
  if (!data) {
    throw new AppError("That ticket could not be found.", 404, { code: "ticket_not_found" });
  }

  if (status) {
    await addMessage(ticketId, {
      authorType: "system",
      authorUserId: adminUserId,
      body: `Status changed to ${status.replace(/_/g, " ")}.`,
      visibleTo: "internal",
    });
  }

  return data;
}

module.exports = {
  TICKET_STATUSES,
  OPEN_STATUSES,
  PROVIDER_TICKET_FIELDS,
  createTicket,
  listTickets,
  getTicketForAdmin,
  listTicketsForProvider,
  getTicketForProvider,
  addMessage,
  setProviderSummary,
  requestOriginal,
  decideOriginalShare,
  updateTicket,
};
