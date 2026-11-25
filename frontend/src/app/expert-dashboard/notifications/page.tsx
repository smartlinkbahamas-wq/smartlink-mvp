"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BellOff, BellRing, CalendarClock, Check, Loader2, ShieldAlert } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  getMyNotificationPreferences,
  updateMyNotificationPreferences,
  type LeadAlertMode,
} from "@/lib/backend-api";

/**
 * Lead alert settings.
 *
 * Three modes, as specified: immediate, one daily summary, or off. Operational
 * notices are deliberately not listed as a fourth toggle -- they are always on,
 * and there is no column for them in notification_preferences, so this screen
 * cannot offer a switch that does not exist.
 */

const OPTIONS: Array<{
  value: LeadAlertMode;
  label: string;
  description: string;
  icon: typeof BellRing;
}> = [
  {
    value: "immediate",
    label: "Immediate",
    description: "Email me as soon as a matching opportunity becomes available.",
    icon: BellRing,
  },
  {
    value: "daily_summary",
    label: "Daily summary",
    description: "One email a day listing every opportunity from the past 24 hours.",
    icon: CalendarClock,
  },
  {
    value: "off",
    label: "Off",
    description:
      "No lead emails. Opportunities still appear in your dashboard, so you will need to check it yourself.",
    icon: BellOff,
  },
];

export default function NotificationSettingsPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LeadAlertMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<LeadAlertMode | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

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

        const response = await getMyNotificationPreferences(token);
        if (!active) return;
        setMode(response.data.preferences.lead_alerts);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not load your notification settings.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [router]);

  async function choose(next: LeadAlertMode) {
    if (next === mode || saving) return;

    const previous = mode;
    setSaving(next);
    setError("");
    setSaved(false);

    // Optimistic, because the control should feel immediate -- but the previous
    // value is kept so a failed save does not leave the screen claiming a
    // setting the server never accepted.
    setMode(next);

    try {
      const token = getAdminAccessToken();
      if (!token) {
        router.replace("/login");
        return;
      }

      const response = await updateMyNotificationPreferences(next, token);
      setMode(response.data.preferences.lead_alerts);
      setSaved(true);
    } catch (err) {
      setMode(previous);
      setError(err instanceof Error ? err.message : "Could not save that setting.");
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Notification Settings</h1>
        <p className="mt-1 text-gray-500">Choose how you hear about new customer opportunities.</p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="sr-only">Lead alert frequency</legend>

        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = mode === option.value;
          const isSaving = saving === option.value;

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={Boolean(saving)}
              onClick={() => choose(option.value)}
              className={`flex w-full items-start gap-4 rounded-xl border p-5 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-900/20"
                  : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700/50"
              }`}
            >
              <Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${
                  selected ? "text-blue-600 dark:text-blue-400" : "text-gray-400"
                }`}
                aria-hidden="true"
              />
              <span className="flex-1">
                <span className="block font-semibold text-gray-900 dark:text-white">
                  {option.label}
                </span>
                <span className="mt-1 block text-sm text-gray-600 dark:text-gray-400">
                  {option.description}
                </span>
              </span>
              {isSaving ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-blue-600" aria-hidden="true" />
              ) : selected ? (
                <Check className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </fieldset>

      {saved && !saving ? (
        <p role="status" className="text-sm font-medium text-green-700 dark:text-green-400">
          Saved.
        </p>
      ) : null}

      {mode === "daily_summary" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          Daily summaries are not being sent yet. Your choice is saved, and summaries will begin once
          the scheduled sending is switched on. Until then, opportunities are still listed in your
          dashboard.
        </div>
      ) : null}

      <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-800/50">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
        <div className="text-sm text-gray-600 dark:text-gray-400">
          <p className="font-semibold text-gray-900 dark:text-white">
            Important notices are always sent
          </p>
          <p className="mt-1">
            Complaints, disputes and administrator decisions reach you regardless of the setting
            above. These cannot be turned off.
          </p>
        </div>
      </div>
    </div>
  );
}
