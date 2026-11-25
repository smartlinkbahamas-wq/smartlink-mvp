const { z } = require("zod");
const { COST_KINDS } = require("../services/quickcost.service");
const { PROVIDER_SETTABLE } = require("../services/job.service");
const { MAX_AMOUNT } = require("../utils/money");

/**
 * Schemas for every priced feature in the Business Hub.
 *
 * Amounts are coerced because forms send strings, and bounded at the
 * numeric(10,2) ceiling -- a larger figure would pass here and then fail in the
 * database as an opaque 500 the provider cannot act on.
 */

const amount = z.coerce
  .number()
  .refine(Number.isFinite, "Enter a valid amount.")
  .refine((value) => value >= 0, "This cannot be negative.")
  .refine((value) => value <= MAX_AMOUNT, "That amount is too large.");

const optionalAmount = amount.optional().nullable();

const quantity = z.coerce
  .number()
  .refine(Number.isFinite, "Enter a valid quantity.")
  .refine((value) => value >= 0, "A quantity cannot be negative.")
  .refine((value) => value <= 1_000_000, "That quantity is too large.");

const percent = z.coerce
  .number()
  .refine(Number.isFinite, "Enter a valid percentage.")
  .refine((value) => value >= 0 && value <= 100, "Enter a percentage between 0 and 100.");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "That date is not valid.");

// --- QuickCost -------------------------------------------------------------

const costItemSchema = z.object({
  kind: z.enum(COST_KINDS),
  label: z.string().trim().min(1, "Give the item a name.").max(160),
  // For labour this is hours; for materials, units. One field, because the
  // arithmetic is identical.
  quantity,
  unitCost: amount,
});

const quickcostSchema = z.object({
  jobName: z.string().trim().min(1, "Give the job a name.").max(200),
  customerSummary: z.string().trim().max(2000).optional().or(z.literal("")),
  internalNotes: z.string().trim().max(4000).optional().or(z.literal("")),
  costItems: z.array(costItemSchema).max(200).optional(),
  overheadAmount: optionalAmount,
  // Capped at 99: the price formula divides by (1 - margin), so 100 is a
  // division by zero.
  targetMarginPercent: z.coerce
    .number()
    .refine(Number.isFinite, "Enter a valid margin.")
    .refine((value) => value >= 0 && value <= 99, "Enter a margin between 0 and 99%.")
    .optional(),
  // Null is meaningful: it means "use the suggested price".
  finalPrice: optionalAmount,
  status: z.enum(["draft", "quoted", "won", "lost", "archived"]).optional(),
});

const quickcostActualsSchema = z.object({
  actualCost: optionalAmount,
  actualRevenue: optionalAmount,
});

// --- Quotations ------------------------------------------------------------

/**
 * A quotation line.
 *
 * An informational line carries a value and no price. Validated as one schema
 * with a refinement rather than a union, so the error message lands on the
 * field the provider needs to fix.
 */
const quotationLineSchema = z
  .object({
    label: z.string().trim().min(1, "Give the line a name.").max(200),
    description: z.string().trim().max(1000).optional().or(z.literal("")),
    quantity: quantity.optional().nullable(),
    unitPrice: optionalAmount,
    unit: z.string().trim().max(40).optional().or(z.literal("")),
    informational: z.boolean().optional(),
    value: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .superRefine((line, ctx) => {
    if (line.informational) return;
    if (line.unitPrice === undefined || line.unitPrice === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitPrice"],
        message: "Enter a price, or mark this line as information only.",
      });
    }
  });

const quotationBaseSchema = z.object({
  customerName: z.string().trim().min(1, "Enter the customer's name.").max(200),
  customerEmail: z.string().trim().email("Enter a valid email address.").max(320),
  customerPhone: z.string().trim().max(60).optional().or(z.literal("")),
  jobName: z.string().trim().min(1, "Give the job a name.").max(200),
  customerSummary: z.string().trim().max(4000).optional().or(z.literal("")),
  terms: z.string().trim().max(8000).optional().or(z.literal("")),
  lineItems: z.array(quotationLineSchema).min(1, "Add at least one line.").max(200),
  discountPercent: percent.optional(),
  discountAmount: optionalAmount,
  discountReason: z.string().trim().max(300).optional().or(z.literal("")),
  taxRatePercent: percent.optional(),
  taxLabel: z.string().trim().max(40).optional().or(z.literal("")),
  additionalCosts: optionalAmount,
  additionalCostsLabel: z.string().trim().max(120).optional().or(z.literal("")),
  // No mandatory minimum: 1 day is allowed, as is 30. Capped at a year so a
  // typo cannot produce a quotation valid for a century.
  validityDays: z.coerce
    .number()
    .int("Enter whole days.")
    .min(1, "Validity must be at least one day.")
    .max(365, "Validity cannot exceed a year.")
    .optional(),
  sourceEstimateId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  introductionRequestId: z.string().uuid().optional().nullable(),
});

const extendValiditySchema = z.object({
  additionalDays: z.coerce
    .number()
    .int("Enter whole days.")
    .min(1, "Enter at least one day.")
    .max(365, "Cannot extend by more than a year."),
});

// --- Customer decision (public) --------------------------------------------

const customerDecisionSchema = z
  .object({
    decision: z.enum(["approve", "decline", "request_changes"]),
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."),
    message: z.string().trim().max(2000).optional().or(z.literal("")),
    acceptedTerms: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    // Approval records that the customer accepted the terms. Approving without
    // ticking it would put an unsupported claim in the record.
    if (value.decision === "approve" && !value.acceptedTerms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedTerms"],
        message: "Please confirm you accept the quotation and its terms.",
      });
    }
    if (value.decision === "request_changes" && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "Tell the provider what you would like changed.",
      });
    }
  });

// --- Invoices --------------------------------------------------------------

const invoiceFromQuotationSchema = z.object({
  depositAmount: optionalAmount,
  dueDate: isoDate.optional(),
  dueInDays: z.coerce.number().int().min(0).max(365).optional(),
  paymentTerms: z.string().trim().max(300).optional().or(z.literal("")),
  paymentInstructions: z.string().trim().max(2000).optional().or(z.literal("")),
  terms: z.string().trim().max(8000).optional().or(z.literal("")),
});

const invoiceUpdateSchema = invoiceFromQuotationSchema.extend({
  lineItems: z.array(quotationLineSchema).max(200).optional(),
  discountPercent: percent.optional(),
  discountAmount: optionalAmount,
  taxRatePercent: percent.optional(),
  additionalCosts: optionalAmount,
});

const paymentSchema = z.object({
  // Strictly positive: zero is not a payment, and a negative row would be a
  // refund, which is a different thing and is not built.
  amount: z.coerce
    .number()
    .refine(Number.isFinite, "Enter a valid amount.")
    .refine((value) => value > 0, "A payment must be more than zero.")
    .refine((value) => value <= MAX_AMOUNT, "That amount is too large."),
  paidOn: isoDate.optional(),
  method: z.string().trim().max(60).optional().or(z.literal("")),
  reference: z.string().trim().max(120).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

// --- Jobs ------------------------------------------------------------------

const manualJobSchema = z.object({
  customerName: z.string().trim().min(1, "Enter the customer's name.").max(200),
  customerEmail: z.string().trim().email().max(320).optional().or(z.literal("")),
  customerPhone: z.string().trim().max(60).optional().or(z.literal("")),
  jobName: z.string().trim().min(1, "Give the job a name.").max(200),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  agreedPrice: optionalAmount,
  expectedCompletionDate: isoDate.optional().nullable(),
  serviceMenuItemId: z.string().uuid().optional().nullable(),
});

const jobFromQuotationSchema = z.object({
  expectedCompletionDate: isoDate.optional().nullable(),
});

const jobStatusSchema = z.object({
  status: z.enum(PROVIDER_SETTABLE),
  actualCompletionDate: isoDate.optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

const jobDateRevisionSchema = z.object({
  requestedDate: isoDate,
  // Required, and required to be substantive: "a reason" that is one character
  // is not a reason an administrator can review.
  reason: z.string().trim().min(5, "Give a reason for the change.").max(1000),
});

// --- Business identity (F7) -------------------------------------------------

const businessIdentitySchema = z
  .object({
    business_name: z.string().trim().max(200).optional().or(z.literal("")),
    business_address: z.string().trim().max(500).optional().or(z.literal("")),
    business_phone: z.string().trim().max(60).optional().or(z.literal("")),
    business_email: z.string().trim().email("Enter a valid email address.").max(320).optional().or(z.literal("")),
    website_url: z.string().trim().max(300).optional().or(z.literal("")),
    logo_url: z.string().trim().max(500).optional().or(z.literal("")),
    vat_registered: z.boolean().optional(),
    vat_number: z.string().trim().max(60).optional().or(z.literal("")),
    hourly_cost_usd: optionalAmount,
  })
  .superRefine((value, ctx) => {
    // Mirrors the database constraint, so the provider gets the message
    // against the VAT number field instead of a 500 naming a constraint.
    if (value.vat_registered && !value.vat_number) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vat_number"],
        message: "Enter your VAT registration number.",
      });
    }
  });

module.exports = {
  quickcostSchema,
  quickcostActualsSchema,
  quotationBaseSchema,
  extendValiditySchema,
  customerDecisionSchema,
  invoiceFromQuotationSchema,
  invoiceUpdateSchema,
  paymentSchema,
  manualJobSchema,
  jobFromQuotationSchema,
  jobStatusSchema,
  jobDateRevisionSchema,
  businessIdentitySchema,
};
