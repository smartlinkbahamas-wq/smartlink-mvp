const { requireSupabase } = require("../utils/supabase-guard");

async function getDashboardOverview(userId) {
  const supabase = requireSupabase();

  // Resolve expert_id from expert_user_links first
  const { data: link, error: linkError } = await supabase
    .from("expert_user_links")
    .select("expert_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (linkError) {
    throw linkError;
  }

  const expertId = link?.expert_id || userId;

  // 1. Fetch expert details
  const { data: expert } = await supabase
    .from("experts")
    .select("*")
    .eq("expert_id", expertId)
    .single();

  // 2. Fetch introduction requests (Opportunities & Clients)
  const { data: requests } = await supabase
    .from("introduction_requests")
    .select("*")
    .eq("expert_id", expertId);

  const reqs = requests || [];
  
  // Calculate Metrics
  // 'more_info' means the provider asked the customer for more detail, so the
  // opportunity is still open and awaiting resolution. It previously matched
  // none of the filters below, which made the request disappear from the
  // provider's list, the customer's list, and both rate calculations.
  const pendingRequests = reqs.filter(
    (r) => r.status === 'submitted' || r.status === 'pending' || r.status === 'more_info',
  );
  const activeClients = reqs.filter(r => r.status === 'accepted');
  const allCompleted = reqs.filter(r => r.status === 'accepted' || r.status === 'declined' || r.status === 'completed');
  
  const responseRate = reqs.length > 0 
    ? Math.round((allCompleted.length / reqs.length) * 100) + "%" 
    : "100%";
    
  const conversionRate = reqs.length > 0
    ? Math.round((activeClients.length / reqs.length) * 100) + "%"
    : "0%";

  // Try fetching impressions for Analytics
  const { data: impressions } = await supabase
    .from("expert_impression_events")
    .select("*")
    .eq("expert_id", expertId);
    
  const profileViews = impressions ? impressions.length : 0;
  
  // Aggregate impressions by date for charts
  const impressionsByDate = {};
  (impressions || []).forEach((imp) => {
    // expert_impression_events timestamps the row as shown_at; reading
    // created_at here produced one bucket labelled "Invalid Date".
    const stamp = imp.shown_at || imp.created_at;
    if (!stamp) return;
    const parsed = new Date(stamp);
    if (Number.isNaN(parsed.getTime())) return;
    const date = parsed.toLocaleDateString();
    impressionsByDate[date] = (impressionsByDate[date] || 0) + 1;
  });
  
  const analytics = {
    impressionsByDate: Object.keys(impressionsByDate).map(date => ({
      date,
      views: impressionsByDate[date]
    }))
  };

  // Fetch reviews
  const { data: reviewsData } = await supabase
    .from("expert_reviews")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });

  // expert_reviews keys on feedback_id and stores the score and text as
  // public_star_rating / public_review_comment. The previous mapping read
  // column names that do not exist, so every review rendered as
  // "Anonymous Client, 5 stars, no comment".
  const reviews = (reviewsData || []).map((r) => ({
    id: r.feedback_id,
    author: "Anonymous Client",
    rating: r.public_star_rating === null || r.public_star_rating === undefined
      ? null
      : Number(r.public_star_rating),
    comment: r.public_review_comment || "",
    wouldRecommend: r.would_recommend,
    status: r.review_status,
    date: r.created_at,
  }));

  const metrics = {
    newMatches: pendingRequests.length,
    pendingRequests: pendingRequests.length,
    activeClients: activeClients.length,
    responseRate,
    averageResponseTime: expert?.average_response_time ? `${expert.average_response_time} hours` : "N/A",
    rating: expert?.rating || 0,
    profileViews: profileViews || 0,
    conversionRate,
  };

  // Build action items from pending requests
  const actionItems = pendingRequests.slice(0, 3).map(r => ({
    id: `action-${r.id}`,
    type: "client_response",
    title: "Pending client response",
    description: `${r.lead_name || "A client"} is waiting for your reply.`,
    urgency: "high"
  }));

  // Build opportunities from pending requests
  const opportunities = pendingRequests.map(r => ({
    id: r.id,
    clientName: r.lead_name || "Confidential Client",
    // Surfaced so an item the provider has already asked about is not shown
    // as if it were a brand new lead.
    status: r.status,
    matchScore: 90, // Placeholder as match score isn't stored in intro request directly
    category: r.category || "General",
    urgency: r.urgency_level || "Medium",
    location: "Remote",
    budgetRange: r.budget_preference || "Flexible",
    description: `A new opportunity in ${r.category || 'your area of expertise'}.`,
    postedAt: r.created_at
  }));

  // Build clients from active/accepted requests
  const clients = activeClients.map(r => ({
    id: r.id,
    clientName: r.lead_name || "Confidential Client",
    email: r.lead_email || "N/A",
    phone: r.lead_phone || "N/A",
    category: r.category || "General",
    status: r.status,
    acceptedAt: r.created_at, // Use created_at as fallback if updated_at is missing
  }));

  return {
    profile: expert,
    metrics,
    actionItems,
    opportunities,
    clients,
    analytics,
    reviews,
  };
}

async function updateExpertProfile(userId, updates) {
  const supabase = requireSupabase();

  const { data: link } = await supabase
    .from("expert_user_links")
    .select("expert_id")
    .eq("user_id", userId)
    .maybeSingle();

  const expertId = link?.expert_id || userId;

  // Fetch current expert record
  const { data: existingExpert } = await supabase
    .from("experts")
    .select("*")
    .eq("expert_id", expertId)
    .single();

  const metadata = existingExpert?.metadata || {};
  const currentPackages = Array.isArray(metadata.custom_packages) ? metadata.custom_packages : [];

  if (updates.custom_packages !== undefined) {
    const newPackages = updates.custom_packages.map((pkg) => {
      const existing = currentPackages.find((p) => p.id === pkg.id);
      return {
        id: pkg.id || `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: pkg.name || pkg.title || "Custom Package",
        description: pkg.description || "",
        priceUsd: Number(pkg.priceUsd || pkg.price || 150),
        deliveryWindow: pkg.deliveryWindow || pkg.delivery_time || "3-5 days",
        category: pkg.category || "General Support",
        status: existing && existing.name === pkg.name && existing.priceUsd === pkg.priceUsd ? existing.status : "pending",
        created_at: existing?.created_at || new Date().toISOString(),
      };
    });
    metadata.custom_packages = newPackages;
    delete updates.custom_packages;
  }

  if (updates.introduction_bio !== undefined) {
    metadata.introduction_bio = {
      text: updates.introduction_bio,
      status: "pending",
      submitted_at: new Date().toISOString(),
    };
    delete updates.introduction_bio;
  }

  updates.metadata = metadata;

  const { data, error } = await supabase
    .from("experts")
    .update(updates)
    .eq("expert_id", expertId)
    .select()
    .single();
    
  if (error) throw error;
  return data;
}

async function reviewExpertPackage(expertId, packageId, status, rejectionReason = "") {
  const supabase = requireSupabase();

  const { data: expert, error: fetchError } = await supabase
    .from("experts")
    .select("*")
    .eq("expert_id", expertId)
    .single();

  if (fetchError || !expert) throw new Error("Expert not found.");

  const metadata = expert.metadata || {};
  const packages = Array.isArray(metadata.custom_packages) ? metadata.custom_packages : [];

  const updatedPackages = packages.map((pkg) => {
    if (pkg.id === packageId) {
      return {
        ...pkg,
        status,
        rejectionReason: status === "rejected" ? rejectionReason : "",
        reviewed_at: new Date().toISOString(),
      };
    }
    return pkg;
  });

  metadata.custom_packages = updatedPackages;

  const { data, error } = await supabase
    .from("experts")
    .update({ metadata })
    .eq("expert_id", expertId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function reviewExpertIntroductionBio(expertId, status) {
  const supabase = requireSupabase();

  const { data: expert, error: fetchError } = await supabase
    .from("experts")
    .select("*")
    .eq("expert_id", expertId)
    .single();

  if (fetchError || !expert) throw new Error("Expert not found.");

  const metadata = expert.metadata || {};
  if (metadata.introduction_bio) {
    metadata.introduction_bio.status = status;
    metadata.introduction_bio.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("experts")
    .update({ metadata })
    .eq("expert_id", expertId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateOpportunityStatus(userId, opportunityId, status) {
  const supabase = requireSupabase();

  const { data: link } = await supabase
    .from("expert_user_links")
    .select("expert_id")
    .eq("user_id", userId)
    .maybeSingle();

  const expertId = link?.expert_id || userId;

  // Read the current stage first so the transition can be recorded as
  // from -> to. The update below overwrites status in place, so this is the
  // only moment the previous value is available.
  const { data: before } = await supabase
    .from("introduction_requests")
    .select("status, lead_id")
    .eq("id", opportunityId)
    .eq("expert_id", expertId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("introduction_requests")
    .update({ status })
    .eq("id", opportunityId)
    .eq("expert_id", expertId)
    .select()
    .single();

  if (error) throw error;

  // Append-only history, so stage-to-stage timing becomes computable. This
  // never throws and never blocks the provider's action.
  const { recordStageEvent, SUBJECT_TYPES, ACTOR_TYPES } = require("./pipeline.service");
  await recordStageEvent({
    subjectType: SUBJECT_TYPES.INTRODUCTION_REQUEST,
    subjectId: opportunityId,
    expertId,
    leadId: before?.lead_id || data?.lead_id || null,
    fromStage: before?.status || null,
    toStage: status,
    actorType: ACTOR_TYPES.EXPERT,
    actorUserId: userId,
  });

  // Accepting an introduction creates the customer record, as specified.
  //
  // Deliberately after the status update and deliberately unable to throw: a
  // provider accepting work must not fail because a bookkeeping row could not
  // be written. A missing customer record is recoverable by hand; a failed
  // acceptance loses the job.
  if (status === "accepted") {
    const { findOrCreateFromLead } = require("./customer.service");
    const leadId = before?.lead_id || data?.lead_id || null;
    const customerId = await findOrCreateFromLead(expertId, leadId, opportunityId);
    if (customerId) {
      return { ...data, customer_id: customerId };
    }
  }

  return data;
}

module.exports = {
  getDashboardOverview,
  updateExpertProfile,
  updateOpportunityStatus,
  reviewExpertPackage,
  reviewExpertIntroductionBio,
};
