const { z } = require("zod");
const { PRICING_MODES } = require("../services/service-menu.service");

/**
 * An optional extra a provider lists against a service -- "travel", "early
 * appointment", "setup". Amount is required: a charge with no figure is not a
 * charge, and would print as a blank line on a customer document.
 */
const additionalChargeSchema = z.object({
  label: z.string().trim().min(1, "Give the charge a name.").max(120),
  amount: z.coerce
    .number()
    .refine(Number.isFinite, "Enter a valid amount.")
    .refine((value) => value >= 0, "An additional charge cannot be negative."),
});

const baseServiceMenuItemSchema = z.object({
  name: z.string().trim().min(1, "Give the service a name.").max(120),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  pricingMode: z.enum(PRICING_MODES),

  // Coerced because the form sends a string. Rejected above 9,999,999.99,
  // which is the ceiling of numeric(10,2) -- a larger figure would be accepted
  // here and then fail in the database as an opaque 500.
  price: z.coerce
    .number()
    .refine(Number.isFinite, "Enter a valid price.")
    .refine((value) => value >= 0, "A price cannot be negative.")
    .refine((value) => value <= 9999999.99, "That price is too large.")
    .optional()
    .nullable(),

  currency: z.string().trim().length(3).optional(),

  durationMinutes: z.coerce
    .number()
    .int("Enter the duration in whole minutes.")
    .positive("Duration must be more than zero.")
    .max(60 * 24 * 30, "That duration is too long.")
    .optional()
    .nullable(),

  additionalCharges: z.array(additionalChargeSchema).max(20).optional(),
  bookable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

/**
 * The price/mode relationship is checked here as well as by the database.
 *
 * The constraint is the guarantee; this exists so the provider gets "Enter a
 * price for a fixed-price service" against the right field, instead of a 500
 * carrying a constraint name.
 */
function enforcePriceMatchesMode(value, ctx) {
  const needsPrice = value.pricingMode === "fixed" || value.pricingMode === "starting_from";
  const hasPrice = value.price !== undefined && value.price !== null;

  if (needsPrice && !hasPrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["price"],
      message:
        value.pricingMode === "fixed"
          ? "Enter a price for a fixed-price service."
          : "Enter the starting price.",
    });
  }
}

const createServiceMenuItemSchema = baseServiceMenuItemSchema.superRefine(enforcePriceMatchesMode);

// Same shape on update: the client sends the whole item, so a partial payload
// would silently blank the fields it left out.
const updateServiceMenuItemSchema = baseServiceMenuItemSchema.superRefine(enforcePriceMatchesMode);

const reorderServiceMenuSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(200),
});

module.exports = {
  createServiceMenuItemSchema,
  updateServiceMenuItemSchema,
  reorderServiceMenuSchema,
};
