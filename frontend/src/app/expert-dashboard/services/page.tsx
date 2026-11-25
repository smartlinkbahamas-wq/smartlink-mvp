"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  getMyServiceMenu,
  createServiceMenuItem,
  updateServiceMenuItem,
  deleteServiceMenuItem,
  reorderServiceMenu,
} from "@/lib/backend-api";
import type {
  ServiceMenuAdditionalCharge,
  ServiceMenuItem,
  ServiceMenuItemInput,
  ServicePricingMode,
} from "@/types";

/**
 * Service Menu.
 *
 * Built before quotations on purpose: a barber, stylist or makeup artist works
 * from a price list and a diary and would never issue a formal quotation. A
 * "Request quote" item is the hand-off into the quotation flow for the work
 * that genuinely needs custom pricing.
 */

const PRICING_MODES: Array<{ value: ServicePricingMode; label: string; hint: string }> = [
  { value: "fixed", label: "Fixed price", hint: "The price is the price." },
  { value: "starting_from", label: "Starting from", hint: "A floor; the final figure is quoted." },
  { value: "request_quote", label: "Request a quote", hint: "No price shown. Priced per job." },
];

interface FormState {
  name: string;
  description: string;
  pricingMode: ServicePricingMode;
  price: string;
  durationMinutes: string;
  additionalCharges: ServiceMenuAdditionalCharge[];
  bookable: boolean;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  pricingMode: "fixed",
  price: "",
  durationMinutes: "",
  additionalCharges: [],
  bookable: false,
  isActive: true,
};

function formatPrice(item: ServiceMenuItem) {
  if (item.pricing_mode === "request_quote") return "Request a quote";
  const amount = Number(item.price ?? 0).toFixed(2);
  const prefix = item.pricing_mode === "starting_from" ? "From " : "";
  return `${prefix}$${amount}`;
}

function formatDuration(minutes: number | null) {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export default function ServiceMenuPage() {
  const router = useRouter();
  const [items, setItems] = useState<ServiceMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const session = await getSessionMe();
        if (!active) return;

        if (!canUseExpertSection(session.role)) {
          router.replace("/login");
          return;
        }

        const token = getAdminAccessToken();
        if (!token) {
          router.replace("/login");
          return;
        }

        const response = await getMyServiceMenu(token);
        if (!active) return;
        setItems(response.data.items || []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your services.");
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [router]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
  }

  function openNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setEditorOpen(true);
  }

  function openEdit(item: ServiceMenuItem) {
    setEditingId(item.id);
    setForm({
      name: item.name,
      description: item.description || "",
      pricingMode: item.pricing_mode,
      price: item.price === null ? "" : String(item.price),
      durationMinutes: item.duration_minutes === null ? "" : String(item.duration_minutes),
      additionalCharges: item.additional_charges || [],
      bookable: item.bookable,
      isActive: item.is_active,
    });
    setFormError("");
    setEditorOpen(true);
  }

  function buildPayload(): ServiceMenuItemInput {
    const priced = form.pricingMode === "fixed" || form.pricingMode === "starting_from";
    return {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      pricingMode: form.pricingMode,
      // Sent as null for request_quote rather than omitted, so switching an
      // existing priced item to "Request a quote" actually clears the price.
      price: priced ? Number(form.price) : null,
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
      additionalCharges: form.additionalCharges.filter((charge) => charge.label.trim()),
      bookable: form.bookable,
      isActive: form.isActive,
    };
  }

  async function handleSave() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");

    try {
      const payload = buildPayload();
      if (editingId) {
        const response = await updateServiceMenuItem(editingId, payload, token);
        setItems((current) =>
          current.map((item) => (item.id === editingId ? response.data : item)),
        );
        setNotice("Service saved.");
      } else {
        const response = await createServiceMenuItem(payload, token);
        setItems((current) => [...current, response.data]);
        setNotice("Service added.");
      }
      setEditorOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save that service.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item: ServiceMenuItem) {
    const token = requireToken();
    if (!token) return;

    setBusyId(item.id);
    setError("");

    try {
      const response = await updateServiceMenuItem(
        item.id,
        {
          name: item.name,
          description: item.description || undefined,
          pricingMode: item.pricing_mode,
          price: item.price,
          durationMinutes: item.duration_minutes,
          additionalCharges: item.additional_charges || [],
          bookable: item.bookable,
          isActive: !item.is_active,
        },
        token,
      );
      setItems((current) => current.map((row) => (row.id === item.id ? response.data : row)));
      setNotice(response.data.is_active ? "Service shown again." : "Service hidden from customers.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change that service.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(item: ServiceMenuItem) {
    if (!window.confirm(`Permanently remove "${item.name}"? This cannot be undone.`)) return;

    const token = requireToken();
    if (!token) return;

    setBusyId(item.id);
    setError("");

    try {
      await deleteServiceMenuItem(item.id, token);
      setItems((current) => current.filter((row) => row.id !== item.id));
      setNotice("Service removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that service.");
    } finally {
      setBusyId(null);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;

    const token = requireToken();
    if (!token) return;

    const previous = items;
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setItems(reordered);
    setBusyId(items[index].id);
    setError("");

    try {
      const response = await reorderServiceMenu(
        reordered.map((item) => item.id),
        token,
      );
      setItems(response.data.items);
    } catch (err) {
      // Put the list back: a half-applied order on screen is worse than none.
      setItems(previous);
      setError(err instanceof Error ? err.message : "Could not save the new order.");
    } finally {
      setBusyId(null);
    }
  }

  function updateCharge(index: number, patch: Partial<ServiceMenuAdditionalCharge>) {
    setForm((current) => ({
      ...current,
      additionalCharges: current.additionalCharges.map((charge, i) =>
        i === index ? { ...charge, ...patch } : charge,
      ),
    }));
  }

  const priced = form.pricingMode === "fixed" || form.pricingMode === "starting_from";

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Service Menu</h1>
          <p className="mt-1 text-gray-500">
            List what you offer and what it costs. Customers see this on your profile.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a service
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}

      {notice && !error ? (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300"
        >
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="underline">
            Dismiss
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">No services listed yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Add the services you offer most often. A barber might list a haircut at a fixed price; a
            makeup artist might list bridal work as &quot;Request a quote&quot;.
          </p>
          <button
            type="button"
            onClick={openNew}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add your first service
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item, index) => {
            const duration = formatDuration(item.duration_minutes);
            const charges = item.additional_charges || [];

            return (
              <li
                key={item.id}
                className={`rounded-xl border bg-white p-5 dark:bg-gray-800 ${
                  item.is_active
                    ? "border-gray-100 dark:border-gray-700"
                    : "border-dashed border-gray-300 opacity-70 dark:border-gray-600"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{item.name}</h3>
                      {!item.is_active ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          Hidden
                        </span>
                      ) : null}
                      {item.bookable ? (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                          Bookable
                        </span>
                      ) : null}
                    </div>

                    {item.description ? (
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {item.description}
                      </p>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                      <span className="font-semibold text-gray-900 dark:text-white">
                        {formatPrice(item)}
                      </span>
                      {duration ? (
                        <span className="inline-flex items-center gap-1 text-gray-500">
                          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                          {duration}
                        </span>
                      ) : null}
                    </div>

                    {charges.length > 0 ? (
                      <p className="mt-2 text-xs text-gray-500">
                        Additional charges:{" "}
                        {charges
                          .map((charge) => `${charge.label} $${Number(charge.amount).toFixed(2)}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || busyId !== null}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 dark:hover:bg-gray-700"
                      aria-label={`Move ${item.name} up`}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === items.length - 1 || busyId !== null}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 dark:hover:bg-gray-700"
                      aria-label={`Move ${item.name} down`}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(item)}
                      disabled={busyId !== null}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 dark:hover:bg-gray-700"
                      aria-label={item.is_active ? `Hide ${item.name}` : `Show ${item.name}`}
                    >
                      {item.is_active ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(item)}
                      disabled={busyId !== null}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-30 dark:hover:bg-gray-700"
                      aria-label={`Edit ${item.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      disabled={busyId !== null}
                      className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-900/20"
                      aria-label={`Remove ${item.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editorOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-labelledby="service-editor-title"
          onClick={() => !saving && setEditorOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <h2
                id="service-editor-title"
                className="text-lg font-semibold text-gray-900 dark:text-white"
              >
                {editingId ? "Edit service" : "Add a service"}
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                disabled={saving}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-700"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
              >
                {formError}
              </div>
            ) : null}

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="service-name"
                  className="mb-1 block text-sm font-medium text-gray-900 dark:text-white"
                >
                  Service name
                </label>
                <input
                  id="service-name"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  maxLength={120}
                  placeholder="Haircut"
                  className="w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label
                  htmlFor="service-description"
                  className="mb-1 block text-sm font-medium text-gray-900 dark:text-white"
                >
                  Description <span className="font-normal text-gray-500">(optional)</span>
                </label>
                <textarea
                  id="service-description"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  rows={2}
                  maxLength={2000}
                  placeholder="What the customer gets."
                  className="w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  How is it priced?
                </legend>
                <div className="space-y-2">
                  {PRICING_MODES.map((mode) => (
                    <label
                      key={mode.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                        form.pricingMode === mode.value
                          ? "border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-900/20"
                          : "border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="pricing-mode"
                        checked={form.pricingMode === mode.value}
                        onChange={() => setForm({ ...form, pricingMode: mode.value })}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-medium text-gray-900 dark:text-white">
                          {mode.label}
                        </span>
                        <span className="text-xs text-gray-500">{mode.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                {priced ? (
                  <div>
                    <label
                      htmlFor="service-price"
                      className="mb-1 block text-sm font-medium text-gray-900 dark:text-white"
                    >
                      Price (USD)
                    </label>
                    <input
                      id="service-price"
                      inputMode="decimal"
                      value={form.price}
                      onChange={(event) =>
                        setForm({ ...form, price: event.target.value.replace(/[^\d.]/g, "") })
                      }
                      placeholder="35.00"
                      className="w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                    />
                  </div>
                ) : null}

                <div>
                  <label
                    htmlFor="service-duration"
                    className="mb-1 block text-sm font-medium text-gray-900 dark:text-white"
                  >
                    Duration in minutes{" "}
                    <span className="font-normal text-gray-500">(optional)</span>
                  </label>
                  <input
                    id="service-duration"
                    inputMode="numeric"
                    value={form.durationMinutes}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        durationMinutes: event.target.value.replace(/\D/g, ""),
                      })
                    }
                    placeholder="30"
                    className="w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Additional charges{" "}
                    <span className="font-normal text-gray-500">(optional)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        additionalCharges: [...form.additionalCharges, { label: "", amount: 0 }],
                      })
                    }
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Add charge
                  </button>
                </div>

                {form.additionalCharges.length === 0 ? (
                  <p className="text-xs text-gray-500">
                    For example travel, an early appointment, or setup.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {form.additionalCharges.map((charge, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          value={charge.label}
                          onChange={(event) => updateCharge(index, { label: event.target.value })}
                          placeholder="Travel"
                          maxLength={120}
                          className="flex-1 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                          aria-label={`Charge ${index + 1} name`}
                        />
                        <input
                          inputMode="decimal"
                          value={String(charge.amount)}
                          onChange={(event) =>
                            updateCharge(index, {
                              amount: Number(event.target.value.replace(/[^\d.]/g, "")) || 0,
                            })
                          }
                          className="w-28 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                          aria-label={`Charge ${index + 1} amount`}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              additionalCharges: form.additionalCharges.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                          className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                          aria-label={`Remove charge ${index + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.bookable}
                  onChange={(event) => setForm({ ...form, bookable: event.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-gray-900 dark:text-white">
                    Customers may book this directly
                  </span>
                  <span className="text-xs text-gray-500">
                    Takes effect once customer booking is available. It changes nothing today.
                  </span>
                </span>
              </label>

              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                />
                <span className="font-medium text-gray-900 dark:text-white">
                  Show this service to customers
                </span>
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                disabled={saving}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !form.name.trim() || (priced && !form.price)}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {editingId ? "Save changes" : "Add service"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
