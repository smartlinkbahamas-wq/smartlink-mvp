const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Service menu: a provider's list of services and prices.
 *
 * The first piece of Priority 2, and deliberately ahead of quotations. A
 * barber, stylist or makeup artist works from a price list and a diary and
 * would never issue a formal quotation; requiring one to use the platform is
 * what made a matching-only product not worth paying for to that group.
 *
 * Every function here is scoped by expert_id. There is no row-level security
 * anywhere in this project, so ownership is enforced in each query rather than
 * by the database, and another provider's item must be indistinguishable from
 * one that does not exist.
 */

const PRICING_MODES = ["fixed", "starting_from", "request_quote"];

const NOT_INSTALLED = "The service menu is not set up yet. Run sql/install_service_menu.sql.";

/** True when the table has not been created on this environment yet. */
function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function rethrow(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "service_menu_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/**
 * Normalises what reaches the database.
 *
 * price is forced to null for request_quote rather than merely ignored: the
 * check constraint rejects a priced request_quote row, so silently passing a
 * leftover price through would surface as an opaque 500 after the provider
 * switched an existing item to "Request quote".
 */
function toRow(payload) {
  const pricingMode = payload.pricingMode;
  const priced = pricingMode === "fixed" || pricingMode === "starting_from";

  return {
    name: String(payload.name).trim(),
    description: payload.description?.trim() || null,
    pricing_mode: pricingMode,
    price: priced ? Number(payload.price) : null,
    currency: payload.currency || "USD",
    duration_minutes: payload.durationMinutes ?? null,
    additional_charges: payload.additionalCharges || [],
    bookable: Boolean(payload.bookable),
    is_active: payload.isActive === undefined ? true : Boolean(payload.isActive),
  };
}

async function listServiceMenu(expertId, { includeInactive = true } = {}) {
  const supabase = requireSupabase();

  let query = supabase
    .from("service_menu_items")
    .select("*")
    .eq("expert_id", expertId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) rethrow(error, "Could not load your service menu.");
  return data || [];
}

/**
 * The customer-facing read: active items only.
 *
 * Separate from listServiceMenu rather than a flag on it, so a public route
 * cannot accidentally be given includeInactive and publish a provider's
 * retired or half-finished items.
 */
async function listPublicServiceMenu(expertId) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("service_menu_items")
    .select("id, name, description, pricing_mode, price, currency, duration_minutes, additional_charges, bookable")
    .eq("expert_id", expertId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    // A missing table must not break a public profile page. An empty menu is
    // the honest answer: this provider has not published one.
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load that service menu.", 500, error.message);
  }
  return data || [];
}

async function createServiceMenuItem(expertId, payload) {
  const supabase = requireSupabase();

  // New items go to the end of the list. Read rather than counted, because a
  // provider who has reordered their menu may have gaps in sort_order.
  const { data: last, error: lastError } = await supabase
    .from("service_menu_items")
    .select("sort_order")
    .eq("expert_id", expertId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) rethrow(lastError, "Could not add that service.");

  const row = {
    ...toRow(payload),
    expert_id: expertId,
    sort_order: (last?.sort_order ?? -1) + 1,
  };

  const { data, error } = await supabase
    .from("service_menu_items")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("You already have an active service with that name.", 409, {
        code: "duplicate_service_name",
      });
    }
    if (error.code === "23503") {
      throw new AppError("No provider profile is linked to this account.", 403, {
        code: "expert_profile_not_linked",
      });
    }
    rethrow(error, "Could not add that service.");
  }

  return data;
}

async function updateServiceMenuItem(expertId, itemId, payload) {
  const supabase = requireSupabase();

  const row = { ...toRow(payload), updated_at: new Date().toISOString() };

  // The expert_id filter is the authorisation check. Without it a provider
  // could edit any item by id.
  const { data, error } = await supabase
    .from("service_menu_items")
    .update(row)
    .eq("id", itemId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("You already have an active service with that name.", 409, {
        code: "duplicate_service_name",
      });
    }
    rethrow(error, "Could not save that service.");
  }

  // 404 rather than 403: another provider's item must not be distinguishable
  // from one that does not exist.
  if (!data) {
    throw new AppError("That service could not be found.", 404, { code: "service_not_found" });
  }

  return data;
}

/**
 * Permanent removal.
 *
 * Safe today because nothing references a menu item. Once quotations can be
 * built from one, this must refuse to delete a referenced item and archive it
 * instead (is_active = false), or an approved quotation will lose the service
 * it was priced from.
 */
async function deleteServiceMenuItem(expertId, itemId) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("service_menu_items")
    .delete()
    .eq("id", itemId)
    .eq("expert_id", expertId)
    .select("id")
    .maybeSingle();

  if (error) rethrow(error, "Could not remove that service.");
  if (!data) {
    throw new AppError("That service could not be found.", 404, { code: "service_not_found" });
  }
  return { id: data.id };
}

/**
 * Applies a new display order.
 *
 * Only items the caller owns are touched, and the ids are re-read first, so a
 * request listing another provider's id reorders nothing rather than failing
 * halfway with some rows already moved.
 */
async function reorderServiceMenu(expertId, orderedIds) {
  const supabase = requireSupabase();

  const { data: owned, error: ownedError } = await supabase
    .from("service_menu_items")
    .select("id")
    .eq("expert_id", expertId)
    .in("id", orderedIds);

  if (ownedError) rethrow(ownedError, "Could not reorder your service menu.");

  const ownedIds = new Set((owned || []).map((item) => item.id));
  const unknown = orderedIds.filter((id) => !ownedIds.has(id));
  if (unknown.length > 0) {
    throw new AppError("That service could not be found.", 404, { code: "service_not_found" });
  }

  // Sequential rather than parallel: a handful of rows, and a partial failure
  // is easier to reason about when the order of writes is known.
  for (let index = 0; index < orderedIds.length; index += 1) {
    const { error } = await supabase
      .from("service_menu_items")
      .update({ sort_order: index, updated_at: new Date().toISOString() })
      .eq("id", orderedIds[index])
      .eq("expert_id", expertId);

    if (error) rethrow(error, "Could not reorder your service menu.");
  }

  return listServiceMenu(expertId);
}

module.exports = {
  PRICING_MODES,
  listServiceMenu,
  listPublicServiceMenu,
  createServiceMenuItem,
  updateServiceMenuItem,
  deleteServiceMenuItem,
  reorderServiceMenu,
};
