"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2, Save, ShieldAlert } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import { getExpertDashboardData, updateExpertProfile } from "@/lib/backend-api";

/**
 * Business details that appear on customer documents.
 *
 * Separate from Profile on purpose: Profile is the marketplace listing that
 * affects matching, while this is the letterhead on a quotation or invoice,
 * plus the one internal figure the cost calculator needs.
 *
 * The VAT fields matter legally: only a registered business may charge VAT,
 * and the registration number has to appear on the document. The database
 * refuses "registered" with no number, and the quotation service refuses a
 * tax rate above zero from an unregistered provider.
 */

interface Form {
  business_name: string;
  business_address: string;
  business_phone: string;
  business_email: string;
  website_url: string;
  vat_registered: boolean;
  vat_number: string;
  hourly_cost_usd: string;
}

const EMPTY: Form = {
  business_name: "",
  business_address: "",
  business_phone: "",
  business_email: "",
  website_url: "",
  vat_registered: false,
  vat_number: "",
  hourly_cost_usd: "",
};

export default function BusinessDetailsPage() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

        const response = await getExpertDashboardData(token);
        if (!active) return;

        const profile = (response as { profile?: Record<string, unknown> }).profile || {};
        setForm({
          business_name: String(profile.business_name || ""),
          business_address: String(profile.business_address || ""),
          business_phone: String(profile.business_phone || ""),
          business_email: String(profile.business_email || ""),
          website_url: String(profile.website_url || ""),
          vat_registered: Boolean(profile.vat_registered),
          vat_number: String(profile.vat_number || ""),
          hourly_cost_usd:
            profile.hourly_cost_usd === null || profile.hourly_cost_usd === undefined
              ? ""
              : String(profile.hourly_cost_usd),
        });
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your details.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  async function handleSave() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return;
    }

    // Checked here as well as by the database, so the message lands next to
    // the field rather than arriving as a constraint name.
    if (form.vat_registered && !form.vat_number.trim()) {
      setError("Enter your VAT registration number, or switch VAT registration off.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    try {
      await updateExpertProfile(
        {
          business_name: form.business_name.trim() || null,
          business_address: form.business_address.trim() || null,
          business_phone: form.business_phone.trim() || null,
          business_email: form.business_email.trim() || null,
          website_url: form.website_url.trim() || null,
          vat_registered: form.vat_registered,
          vat_number: form.vat_registered ? form.vat_number.trim() : null,
          hourly_cost_usd: form.hourly_cost_usd === "" ? null : Number(form.hourly_cost_usd),
        },
        token,
      );
      setNotice("Business details saved. New quotations and invoices will use them.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your details.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white";
  const labelClass = "mb-1 block text-sm font-medium text-gray-900 dark:text-white";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <Building2 className="h-6 w-6 text-blue-600" aria-hidden="true" />
          Business Details
        </h1>
        <p className="mt-1 text-gray-500">
          These appear at the top of every quotation and invoice you send.
        </p>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {notice && !error ? (
        <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
          {notice}
        </div>
      ) : null}

      <div className="space-y-4 rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <div>
          <label htmlFor="b-name" className={labelClass}>Business name</label>
          <input id="b-name" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} placeholder="Island Blooms Ltd" className={inputClass} />
          <p className="mt-1 text-xs text-gray-500">If you leave this blank, your profile name is used.</p>
        </div>

        <div>
          <label htmlFor="b-address" className={labelClass}>Business address</label>
          <textarea id="b-address" rows={2} value={form.business_address} onChange={(e) => setForm({ ...form, business_address: e.target.value })} placeholder="12 Bay Street, Nassau" className={inputClass} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="b-phone" className={labelClass}>Business phone</label>
            <input id="b-phone" value={form.business_phone} onChange={(e) => setForm({ ...form, business_phone: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label htmlFor="b-email" className={labelClass}>Business email</label>
            <input id="b-email" type="email" value={form.business_email} onChange={(e) => setForm({ ...form, business_email: e.target.value })} className={inputClass} />
          </div>
        </div>

        <div>
          <label htmlFor="b-website" className={labelClass}>Website <span className="font-normal text-gray-500">(optional)</span></label>
          <input id="b-website" value={form.website_url} onChange={(e) => setForm({ ...form, website_url: e.target.value })} placeholder="islandblooms.bs" className={inputClass} />
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="font-semibold text-gray-900 dark:text-white">VAT registration</h2>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.vat_registered}
            onChange={(e) => setForm({ ...form, vat_registered: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-gray-900 dark:text-white">
              My business is registered to charge VAT
            </span>
            <span className="text-xs text-gray-500">
              Only tick this if you are genuinely registered. Until you do, tax on a quotation is
              refused.
            </span>
          </span>
        </label>

        {form.vat_registered ? (
          <div>
            <label htmlFor="b-vat" className={labelClass}>VAT registration number</label>
            <input id="b-vat" value={form.vat_number} onChange={(e) => setForm({ ...form, vat_number: e.target.value })} placeholder="VAT-000000" className={inputClass} />
            <p className="mt-1 text-xs text-gray-500">This is printed on every document that charges VAT.</p>
          </div>
        ) : null}
      </div>

      <div className="space-y-4 rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="font-semibold text-gray-900 dark:text-white">Your hourly cost</h2>

        <div className="flex items-start gap-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            This is what an hour of work <strong>costs your business</strong>, not what you charge.
            It is used only by the cost calculator and is never shown to a customer or used for
            matching. Your charge-out rate is on the Profile page.
          </span>
        </div>

        <div className="max-w-xs">
          <label htmlFor="b-cost" className={labelClass}>Cost per hour (USD)</label>
          <input
            id="b-cost"
            inputMode="decimal"
            value={form.hourly_cost_usd}
            onChange={(e) => setForm({ ...form, hourly_cost_usd: e.target.value.replace(/[^\d.]/g, "") })}
            placeholder="45.00"
            className={inputClass}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save business details
      </button>
    </div>
  );
}
