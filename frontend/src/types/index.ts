export type RiskLevel = "low" | "moderate" | "high" | "critical";
export type AssessmentMode = "business-services" | "cybersecurity-risk";
export type LeadTier = "standard" | "premium";
export type ExpertVisibilityLevel = "basic" | "featured" | "priority";
export type MatchingVisibility = "visible" | "priority-only" | "hidden";
export type AudienceSegment = "business-owner" | "personal-help" | "not-sure";
export type ResultsFeedbackAnswer = "yes" | "somewhat" | "no";
export type MissingFeedbackReason =
  | "not_relevant"
  | "no_response"
  | "too_expensive"
  | "wrong_location"
  | "different_help_needed"
  | "other";
export type ConnectionStatus = "pending" | "connected" | "not-yet" | "not-connected";
export type ExpertSubscriptionTier = "basic" | "premium" | "featured";
export type IntroductionRequestStatus = "submitted" | "reviewed" | "sent-to-expert" | "accepted" | "declined";
export type ExpertResponseStatus = "pending" | "responded" | "not-responded";
export type UserActionType =
  | "expert_match_viewed"
  | "expert_card_clicked"
  | "service_selected"
  | "service_removed"
  | "introduction_requested"
  | "expert_match_exited";

export type QuizCategory =
  | "Operations"
  | "Cybersecurity"
  | "Systems"
  | "Growth"
  | "Career Help"
  | "Financial Advice"
  | "Legal Help"
  | "Personal Tech Support"
  | "General Support";

export interface Option {
  id: string;
  label: string;
  text: string;
  riskPoints: number;
  explanation: string;
  tags: string[];
}

export interface Question {
  id: string;
  text: string;
  category: QuizCategory;
  options: Option[];
  objective: string;
}

export interface AssessmentCategorySummary {
  category: QuizCategory;
  riskPoints: number;
  maxRiskPoints: number;
  riskLevel: RiskLevel;
}

export interface AssessmentResult {
  assessmentId: string;
  submittedAt: string;
  totalRiskPoints: number;
  normalizedScore: number;
  riskLevel: RiskLevel;
  categoryBreakdown: AssessmentCategorySummary[];
  strengths: string[];
  priorityActions: string[];
  recommendedExpertIds: string[];
}

export interface LeadCaptureInfo {
  fullName: string;
  workEmail: string;
  phoneNumber?: string;
  audienceSegment?: AudienceSegment;
  companyName?: string;
  role?: string;
  businessType?: string;
  location: string;
  locationScope?: "bahamas" | "outside-bahamas";
  island?: string;
  website?: string;
  teamSize?: string;
  budgetPreference?: string;
  urgencyPreference?: string;
  priorConsultingExperience?: string;
}

export interface LeadTrackingRecord {
  expertId: string;
  matchScore: number;
  matchTier: string;
  leadTier: LeadTier;
  visibilityLevel: ExpertVisibilityLevel;
  status: "new" | "contacted" | "qualified";
}

export interface RankingControlSnapshot {
  expertId: string;
  visibilityLevel: ExpertVisibilityLevel;
  matchingVisibility: MatchingVisibility;
  rankingWeightBoost: number;
}

export interface IntroductionRequest {
  id: string;
  assessmentId: string;
  expertId: string;
  expertName: string;
  leadName: string;
  leadEmail: string;
  leadPhone?: string;
  requestedAt: string;
  serviceIds: string[];
  serviceNames: string[];
  category: QuizCategory;
  urgencyLevel?: string;
  budgetPreference?: string;
  billable: boolean;
  leadTier: LeadTier;
  expertTier: ExpertSubscriptionTier;
  status: IntroductionRequestStatus;
}

export interface ExpertPerformanceRecord {
  expertId: string;
  expertName: string;
  subscriptionTier: ExpertSubscriptionTier;
  leadsReceived: number;
  introductionRequests: number;
  clickCount: number;
  selectionCount: number;
  responseTimeHours?: number;
  responseStatus: ExpertResponseStatus;
}

export interface UserActionEvent {
  id: string;
  assessmentId: string;
  actionType: UserActionType;
  timestamp: string;
  expertId?: string;
  expertName?: string;
  category?: QuizCategory;
  urgencyLevel?: string;
  budgetPreference?: string;
  dropOffPoint?: string;
}

export interface LeadsPerCategorySnapshot {
  category: QuizCategory;
  count: number;
}

export interface ConversionIndicatorSnapshot {
  label: string;
  value: number;
}

export interface AdminAnalyticsSnapshot {
  totalLeadsGenerated: number;
  leadsPerCategory: LeadsPerCategorySnapshot[];
  topPerformingExpertIds: string[];
  conversionIndicators: ConversionIndicatorSnapshot[];
}

export interface AssessmentResponseItem {
  questionId: string;
  questionText: string;
  category: QuizCategory;
  selectedOptionId: string;
  selectedOptionLabel: string;
  selectedOptionText: string;
  selectedOptionRiskPoints: number;
}

export interface ExpertFeedbackRecord {
  status?: "positive" | "neutral" | "negative";
  notes?: string;
  submittedAt?: string;
}

export interface FeedbackLoopData {
  userFeedback?: ResultsFeedbackAnswer;
  missingReasons?: MissingFeedbackReason[];
  userFeedbackSubmittedAt?: string;
  connectionStatus?: ConnectionStatus;
  connectionCheckedAt?: string;
  expertFeedback?: ExpertFeedbackRecord;
}

export interface DiagnosticProfile {
  categoryOptionId?: string;
  categoryOptionText?: string;
  situationOptionId?: string;
  situationOptionText?: string;
  goalOptionId?: string;
  goalOptionText?: string;
  smartIntentTag?: "do_it_for_me" | "advice" | "guided";
  urgentProblemSignal?: boolean;
  premiumDoItForMeSignal?: boolean;
  needsGuidedExperienceSignal?: boolean;
}

export interface AssessmentSubmission {
  assessmentId: string;
  submittedAt: string;
  assessmentMode: AssessmentMode;
  leadTier: LeadTier;
  totalQuestions: number;
  answeredQuestions: number;
  totalRiskPoints: number;
  maxRiskPoints: number;
  normalizedScore: number;
  riskLevel: RiskLevel;
  highestRiskCategory: QuizCategory;
  categoryBreakdown: AssessmentCategorySummary[];
  priorityActions: string[];
  recommendedExpertIds: string[];
  lead: LeadCaptureInfo;
  responses: AssessmentResponseItem[];
  leadTracking: LeadTrackingRecord[];
  rankingControlSnapshot: RankingControlSnapshot[];
  diagnosticProfile?: DiagnosticProfile;
  feedbackLoop?: FeedbackLoopData;
  introductionRequests?: IntroductionRequest[];
  expertPerformanceTracking?: ExpertPerformanceRecord[];
  userActionEvents?: UserActionEvent[];
  adminAnalyticsSnapshot?: AdminAnalyticsSnapshot;
}

export interface Expert {
  id: string;
  fullName: string;
  role: string;
  organization: string;
  yearsExperience: number;
  specialties: QuizCategory[];
  certifications: string[];
  languages: string[];
  timezone: string;
  rating: number;
  hourlyRateUsd: number;
  nextAvailableAt: string;
  bio: string;
  visibilityLevel: ExpertVisibilityLevel;
  matchingVisibility: MatchingVisibility;
  rankingWeightBoost: number;
  subscriptionTier?: ExpertSubscriptionTier;
}

export interface QuizSection {
  id: string;
  title: string;
  description: string;
  weight: number;
  questions: Question[];
}

export interface QuizData {
  id: string;
  title: string;
  description: string;
  estimatedDurationMinutes: number;
  passingScore: number;
  sections: QuizSection[];
}

export interface QuizEnginePayload {
  tenantId: string;
  locale: string;
  version: string;
  fetchedAt: string;
  quiz: QuizData;
  experts: Expert[];
  sampleAssessmentResult: AssessmentResult;
}

export interface BackendMatchBreakdown {
  baseScore: number;
  fairnessBoost: number;
  performanceScore: number;
  priorityBoost: number;
  cooldownAdjustment: number;
  category: number;
  urgency: number;
  budget: number;
  reputation: number;
  location: number;
  budgetFitLabel: string;
  urgencyFitLabel: string;
  categoryFitLabel: string;
  locationFitLabel: string;
}

export interface BackendMatchRecommendation {
  rank: number;
  expertId: string;
  expert: Expert;
  matchScore: number;
  matchBand: "Best Match" | "Strong Match" | "Good Match";
  slotLabel?: "Top Match" | "Strong Match" | "Rising Expert" | null;
  badges: string[];
  availableNow: boolean;
  explanation: string;
  breakdown: BackendMatchBreakdown;
}

export type AdminRole = "super_admin" | "admin" | "moderator" | "auditor";

export interface AdminMe {
  userId: string;
  email: string | null;
  role: AdminRole;
  roles: AdminRole[];
  permissions: string[];
}

export interface AdminUserRoleRecord {
  id: string;
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
  role: AdminRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserOption {
  id: string;
  label: string;
  subtitle: string;
}

export interface AdminExpertOption {
  id: string;
  label: string;
  subtitle: string;
  matching_visibility?: "visible" | "priority-only" | "hidden";
  is_paused?: boolean;
}

export interface AdminLeadOption {
  id: string;
  label: string;
  subtitle: string;
}

export interface ExpertApplicationRecord {
  application_id: string;
  expert_id: string;
  expert_name?: string | null;
  expert_role?: string | null;
  expert_organization?: string | null;
  expert_location?: string | null;
  expert_availability_status?: string | null;
  expert_hourly_rate_usd?: number | null;
  expert_category_tags?: string[];
  expert_service_tags?: string[];
  expert_profile_metadata?: Record<string, unknown>;
  metadata?: Record<string, any>;
  status: "under_review" | "needs_info" | "approved" | "rejected" | "flagged";
  submitted_by_user_id?: string | null;
  reviewed_by_user_id?: string | null;
  approved_by_user_id?: string | null;
  rejected_by_user_id?: string | null;
  recommendation?: string | null;
  requested_info_notes?: string | null;
  review_notes?: string | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpertProfileSummary {
  expert_id: string;
  name: string;
  role?: string | null;
  organization?: string | null;
  location?: string | null;
  availability_status?: string | null;
  hourly_rate_usd?: number | null;
  category_tags?: string[];
  service_tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ExpertApplicationStatusView {
  application: ExpertApplicationRecord | null;
  expert: ExpertProfileSummary | null;
}

export interface LeadAssignmentRecord {
  assignment_id: string;
  lead_id: string;
  lead_label?: string | null;
  expert_id: string;
  expert_label?: string | null;
  assigned_by_user_id: string;
  assigned_by_role: string;
  assignment_reason: string;
  is_high_value_lead: boolean;
  notes?: string | null;
  created_at: string;
}

export interface PlatformPricingSettings {
  id: string;
  is_active: boolean;
  lead_price_low: number;
  lead_price_medium: number;
  lead_price_high: number;
  pricing_band_low: string;
  pricing_band_medium: string;
  pricing_band_high: string;
  high_value_criteria: {
    requireUrgent: boolean;
    requireBudget: boolean;
    requireIntent: boolean;
    budgetLevels: ("low" | "medium" | "high" | "exploring")[];
    intentTypes: ("do_it_for_me" | "advice" | "guided")[];
  };
  created_at: string;
  updated_at: string;
}

export interface AdminFairnessSettings {
  id: string;
  fairness_boost_max: number;
  new_expert_boost_days: number;
  new_expert_boost_value: number;
  cooldown_threshold: number;
  new_expert_boost_enabled: boolean;
  exposure_boost_strength: "low" | "medium" | "high";
  rotation_frequency: "aggressive" | "balanced" | "minimal";
}

export interface AdminMatchOverrideRecord {
  id: string;
  lead_id?: string | null;
  assessment_id?: string | null;
  ordered_expert_ids: string[];
  ordered_expert_labels?: string[];
  allow_hidden_experts: boolean;
  is_active: boolean;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  lead_label?: string | null;
}

export interface AdminModerationReviewRecord {
  feedback_id: string;
  expert_id?: string | null;
  lead_id?: string | null;
  public_star_rating?: number | null;
  public_review_comment?: string | null;
  review_status: "approved" | "rejected" | "pending";
  is_suspicious?: boolean;
  suspicious_notes?: string | null;
  created_at: string;
  expert_label?: string | null;
  lead_label?: string | null;
  pending_recommendations_count?: number;
}

export interface ReviewModerationRecommendationRecord {
  id: string;
  review_id: string;
  moderator_user_id: string;
  moderator_email?: string | null;
  recommendation: "approve" | "reject";
  notes?: string | null;
  status: "pending" | "resolved";
  resolved_by_user_id?: string | null;
  resolved_at?: string | null;
  created_at: string;
  updated_at: string;
  review?: AdminModerationReviewRecord | null;
}

export interface AdminAuditLogRecord {
  audit_id: string;
  user_id?: string | null;
  user_email?: string | null;
  role?: string | null;
  action_type: string;
  target_type?: string | null;
  target_id?: string | null;
  previous_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
  timestamp: string;
  ip_address?: string | null;
  notes?: string | null;
}

export interface ConversionRate {
  numerator: number;
  denominator: number;
  /** null when the denominator is zero — never shown as 0%. */
  percent: number | null;
}

export interface AdminReportsSummary {
  totalApplications: number;
  totalLeads: number;
  totalLeadsToday?: number;
  totalLeadsMonthToDate?: number;
  highValueLeads: number;
  noMatchLeads?: number;
  /** @deprecated Now the expert-acceptance rate. Prefer the two fields below. */
  conversionRate?: number;
  /** A rate always carries its denominator, so the UI can show "2 of 9". */
  inquiryToExpertRate?: ConversionRate;
  expertAcceptanceRate?: ConversionRate;
  leadsReachingAnExpert?: number;
  averageResponseTimeHours?: number;
  introductionsCount?: number;
  connectedIntroductionsCount?: number;
  totalReviews: number;
  approvedReviews: number;
  suspiciousReviews?: number;
  totalExperts: number;
  activeExperts: number;
  featuredExperts: number;
  notRespondingExperts?: number;
  leadsByCategory: Record<string, number>;
}

export interface AdminLeadEscalationRecord {
  id: string;
  label: string;
  work_email?: string | null;
  subtitle: string;
  is_high_value: boolean;
  urgency_preference?: string | null;
  budget_preference?: string | null;
  intent_type?: string | null;
  primary_issue?: string | null;
}

export interface AdminExpertPerformanceRecord {
  expert_id: string;
  expert_name: string;
  profile_views: number;
  impressions: number;
  click_through_rate: number;
  response_time_hours: number;
  conversion_rate: number;
  rating: number;
  status_label: "High Performer" | "Needs Improvement" | "New Expert";
}

export interface AdminReviewsFeedbackSummary {
  trends: {
    approved_review_count: number;
    low_rating_count: number;
    suspicious_count: number;
    rating_buckets: Record<string, number>;
  };
  complaints: Array<{
    expert_id: string;
    expert_name: string;
    low_feedback_count: number;
  }>;
  alerts: {
    multiple_low_ratings: Array<{
      expert_id: string;
      expert_name: string;
      low_feedback_count: number;
    }>;
    not_responding_experts: Array<{
      expert_id: string;
      expert_name: string;
      response_time_hours: number;
    }>;
  };
}

export type CategorySegment = "business-owner" | "personal-help" | "not-sure";

export interface CategoryQuestionOption {
  id: string;
  label: string;
  support: string;
  riskPoints: number;
}

export interface CategoryQuestion {
  id: string;
  category_id: string;
  slug: string;
  text: string;
  helper: string | null;
  options: CategoryQuestionOption[];
  sort_order: number;
  is_active: boolean;
}

export interface ServiceCategory {
  id: string;
  parent_id: string | null;
  slug: string;
  label: string;
  support_text: string | null;
  risk_points: number;
  segments: CategorySegment[];
  sort_order: number;
  is_active: boolean;
  questions: CategoryQuestion[];
  children: ServiceCategory[];
}

// A provider's report that an opportunity is not genuine, as the administrator
// review queue sees it. The *_name / customer_* fields are stitched on by the
// backend from experts and lead_submissions; they are null when that lookup
// could not be completed, so the UI must tolerate missing detail.
export interface AdminSuspiciousLeadReport {
  id: string;
  introduction_request_id: string;
  lead_id: string | null;
  expert_id: string;
  reported_by_user_id: string | null;
  reason: string;
  notes: string | null;
  status: "new" | "under_review" | "actioned" | "dismissed";
  review_outcome: string | null;
  review_notes: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  expert_name: string | null;
  expert_organization: string | null;
  customer_name: string | null;
  customer_email: string | null;
  lead_category: string | null;
  lead_created_at: string | null;
}

// A single service on a provider's menu.
//
// price is null exactly when pricing_mode is "request_quote" -- the database
// enforces that pairing, so the UI can rely on it rather than guarding both.
export type ServicePricingMode = "fixed" | "starting_from" | "request_quote";

export interface ServiceMenuAdditionalCharge {
  label: string;
  amount: number;
}

export interface ServiceMenuItem {
  id: string;
  expert_id: string;
  name: string;
  description: string | null;
  pricing_mode: ServicePricingMode;
  price: number | null;
  currency: string;
  duration_minutes: number | null;
  additional_charges: ServiceMenuAdditionalCharge[];
  bookable: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// What the form sends. Separate from the row above because the API takes
// camelCase and the row comes back snake_case.
export interface ServiceMenuItemInput {
  name: string;
  description?: string;
  pricingMode: ServicePricingMode;
  price?: number | null;
  durationMinutes?: number | null;
  additionalCharges?: ServiceMenuAdditionalCharge[];
  bookable?: boolean;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Business Hub (Priority 2)
// ---------------------------------------------------------------------------

export type CostKind = "material" | "labour" | "subcontractor" | "transport" | "equipment" | "other";

export interface CostItem {
  kind: CostKind;
  label: string;
  // For labour this is hours; for materials, units. The arithmetic is the same.
  quantity: number;
  unitCost: number;
  lineCost?: number;
}

export interface QuickCostEstimate {
  id: string;
  expert_id: string;
  job_name: string;
  customer_summary: string | null;
  internal_notes: string | null;
  cost_items: CostItem[];
  overhead_amount: number;
  target_margin_percent: number;
  items_cost: number;
  total_cost: number;
  suggested_price: number;
  final_price: number;
  profit: number;
  margin_percent: number;
  markup_percent: number;
  actual_cost: number | null;
  actual_revenue: number | null;
  currency: string;
  status: "draft" | "quoted" | "won" | "lost" | "archived";
  created_at: string;
  updated_at: string;
}

/**
 * A quotation or invoice line.
 *
 * An informational line carries a `value` and no figures: a florist's event
 * date or flower colours appear on the document without affecting the price.
 */
export interface DocumentLineItem {
  label: string;
  description?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  unit?: string | null;
  lineTotal?: number;
  informational?: boolean;
  value?: string | null;
}

export interface BusinessIdentitySnapshot {
  business_name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  vat_registered: boolean;
  vat_number: string | null;
  captured_at?: string;
}

export type QuotationStatus =
  | "draft"
  | "sent"
  | "approved"
  | "declined"
  | "changes_requested"
  | "superseded";

export interface Quotation {
  id: string;
  expert_id: string;
  quotation_number: number;
  reference: string;
  lead_id: string | null;
  source_estimate_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  job_name: string;
  customer_summary: string | null;
  terms: string | null;
  line_items: DocumentLineItem[];
  discount_percent: number;
  discount_amount: number;
  discount_reason: string | null;
  tax_rate_percent: number;
  tax_label: string;
  additional_costs: number;
  additional_costs_label: string;
  subtotal: number;
  discount_total: number;
  taxable_amount: number;
  tax_amount: number;
  total: number;
  currency: string;
  validity_days: number;
  valid_until: string | null;
  status: QuotationStatus;
  version: number;
  business_identity: BusinessIdentitySnapshot | null;
  sent_at: string | null;
  approved_at: string | null;
  approval_method: string | null;
  responded_at: string | null;
  customer_message: string | null;
  created_at: string;
  updated_at: string;
  // Server-derived. Expiry is computed, never stored.
  effective_status: QuotationStatus | "expired";
  is_expired: boolean;
  is_locked: boolean;
}

export interface QuotationInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  jobName: string;
  customerSummary?: string;
  terms?: string;
  lineItems: DocumentLineItem[];
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  taxRatePercent?: number;
  taxLabel?: string;
  additionalCosts?: number;
  additionalCostsLabel?: string;
  validityDays?: number;
  sourceEstimateId?: string | null;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  paid_on: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
}

export interface Invoice {
  id: string;
  expert_id: string;
  invoice_number: number;
  reference: string;
  quotation_id: string | null;
  quotation_reference: string | null;
  customer_name: string;
  customer_email: string;
  job_name: string;
  customer_summary: string | null;
  terms: string | null;
  line_items: DocumentLineItem[];
  discount_total: number;
  discount_reason: string | null;
  tax_rate_percent: number;
  tax_label: string;
  tax_amount: number;
  additional_costs: number;
  additional_costs_label: string;
  subtotal: number;
  total: number;
  currency: string;
  deposit_amount: number;
  payment_terms: string | null;
  payment_instructions: string | null;
  issue_date: string;
  due_date: string | null;
  status: "draft" | "sent" | "cancelled";
  business_identity: BusinessIdentitySnapshot | null;
  created_at: string;
  // Derived from the payment rows and the due date on every read, never stored.
  payments: InvoicePayment[];
  paid: number;
  balance: number;
  paymentStatus: "unpaid" | "partially_paid" | "paid";
  isOverdue: boolean;
  displayStatus: string;
}

export type JobStatus =
  | "awarded"
  | "scheduled"
  | "in_progress"
  | "delayed"
  | "provider_completed"
  | "customer_confirmed"
  | "disputed"
  | "cancelled"
  | "unverifiable";

export interface Job {
  id: string;
  expert_id: string;
  job_number: number;
  reference: string;
  quotation_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  job_name: string;
  description: string | null;
  agreed_price: number | null;
  currency: string;
  // Recorded at creation and never changed: it is what separates work the
  // platform produced from work a provider merely recorded.
  source: "smartlink" | "provider_entered";
  status: JobStatus;
  expected_completion_date: string | null;
  original_expected_completion_date: string | null;
  actual_completion_date: string | null;
  completion_notes: string | null;
  created_at: string;
  overdue_days: number;
  is_overdue: boolean;
  work_started: boolean;
}

export interface JobDateRevision {
  id: string;
  previous_date: string | null;
  requested_date: string;
  reason: string;
  approval_status: "auto" | "pending" | "approved" | "rejected";
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
}

/** The customer's view of a quotation. Deliberately narrower than Quotation. */
export interface CustomerQuotationView {
  reference: string;
  version: number;
  jobName: string;
  customerSummary: string | null;
  customerName: string;
  terms: string | null;
  lineItems: DocumentLineItem[];
  subtotal: number;
  discountPercent: number;
  discountTotal: number;
  discountReason: string | null;
  taxLabel: string;
  taxRatePercent: number;
  taxAmount: number;
  additionalCostsLabel: string;
  additionalCosts: number;
  total: number;
  currency: string;
  validUntil: string | null;
  status: string;
  business: BusinessIdentitySnapshot | null;
}

export interface CustomerInvoiceView {
  reference: string;
  quotationReference: string | null;
  jobName: string;
  customerName: string;
  customerSummary: string | null;
  terms: string | null;
  lineItems: DocumentLineItem[];
  subtotal: number;
  discountTotal: number;
  discountReason: string | null;
  taxLabel: string;
  taxRatePercent: number;
  taxAmount: number;
  additionalCostsLabel: string;
  additionalCosts: number;
  total: number;
  depositAmount: number;
  amountPaid: number;
  balanceDue: number;
  paymentStatus: string;
  isOverdue: boolean;
  issueDate: string;
  dueDate: string | null;
  paymentTerms: string | null;
  paymentInstructions: string | null;
  currency: string;
  business: BusinessIdentitySnapshot | null;
  paymentHistory: Array<{ amount: number; paidOn: string; method: string | null }>;
}

// A provider's customer record. Email is the primary identifier -- the
// database enforces one record per address per provider, case-insensitively.
export interface Customer {
  id: string;
  expert_id: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  // Recorded at creation and never changed.
  source: "smartlink" | "provider_entered";
  first_lead_id: string | null;
  notes: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerHistory {
  quotations: Array<{
    id: string; reference: string; job_name: string; total: number;
    currency: string; status: string; valid_until: string | null; created_at: string;
  }>;
  invoices: Array<{
    id: string; reference: string; job_name: string; total: number;
    currency: string; status: string; due_date: string | null; created_at: string;
  }>;
  jobs: Array<{
    id: string; reference: string; job_name: string; status: string;
    agreed_price: number | null; currency: string;
    expected_completion_date: string | null; created_at: string;
  }>;
}
