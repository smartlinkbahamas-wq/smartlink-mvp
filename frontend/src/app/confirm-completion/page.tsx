"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";

/**
 * The customer confirms whether work was actually completed.
 *
 * Four options, exactly as specified. Three of them flag the job for review
 * and offer support — only "completed satisfactorily" closes it.
 *
 * No verification code here, unlike quotation approval. The four options are
 * not a financial commitment, and a second step measurably reduces the
 * response rate — which would push more jobs into the telephone queue, the
 * exact administrative cost this is meant to reduce.
 *
 * The token comes from the URL fragment, which is never sent to a server and
 * never appears in a Referer header.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000/api";

const OPTIONS = [
  {
    value: "completed_satisfactorily",
    label: "Yes, completed satisfactorily",
    hint: "The work was done and you are happy with it.",
    tone: "positive",
  },
  {
    value: "completed_with_concerns",
    label: "Completed, but I have concerns",
    hint: "It was finished, but something was not right.",
    tone: "caution",
  },
  {
    value: "partially_completed",
    label: "Only partially completed",
    hint: "Some of the work was done, but not all of it.",
    tone: "caution",
  },
  {
    value: "not_completed",
    label: "Not completed",
    hint: "The work was not done.",
    tone: "negative",
  },
] as const;

type Outcome = (typeof OPTIONS)[number]["value"];

interface JobView {
  reference: string;
  jobName: string;
  description: string | null;
  customerName: string;
  completedOn: string | null;
  providerName: string;
}

function readToken() {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  return params.get("t") || new URLSearchParams(window.location.search).get("t") || "";
}

async function post<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/confirm-completion${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Document-Token": token },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message || text;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function ConfirmCompletionPage() {
  const [token, setToken] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [comments, setComments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState("");

  // The satisfaction survey, on the same screen. Everything here is optional:
  // the confirmation above is the answer that matters, and a form demanding
  // nine responses is one most people abandon.
  const [overallRating, setOverallRating] = useState<number | null>(null);
  const [detailRatings, setDetailRatings] = useState<Record<string, number>>({});
  const [showDetail, setShowDetail] = useState(false);
  const [scopeAsAgreed, setScopeAsAgreed] = useState<boolean | null>(null);
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(null);
  const [wouldUseAgain, setWouldUseAgain] = useState<boolean | null>(null);
  const [publicReviewOptIn, setPublicReviewOptIn] = useState(false);

  useEffect(() => {
    const found = readToken();
    setToken(found);

    if (!found) {
      setError("This link is incomplete. Please open the link from your email again.");
      setLoading(false);
      return;
    }

    let active = true;
    (async () => {
      try {
        const result = await post<{
          data: { job: JobView; alreadyConfirmed: boolean };
        }>("/", found);
        if (!active) return;
        setJob(result.data.job);
        setAlreadyConfirmed(result.data.alreadyConfirmed);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "This link is no longer valid.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit() {
    if (!outcome) return;
    setSubmitting(true);
    setSubmitError("");

    try {
      const result = await post<{ message: string }>("/submit", token, {
        outcome,
        comments: comments.trim() || undefined,
        // Sent only when the customer actually rated. Omitting them entirely
        // is what keeps the survey optional rather than silently recording
        // nulls as answers.
        ...(overallRating
          ? {
              overallRating,
              qualityRating: detailRatings.quality,
              timelinessRating: detailRatings.timeliness,
              professionalismRating: detailRatings.professionalism,
              communicationRating: detailRatings.communication,
              scopeAsAgreed: scopeAsAgreed ?? undefined,
              wouldRecommend: wouldRecommend ?? undefined,
              wouldUseAgain: wouldUseAgain ?? undefined,
              publicReviewOptIn,
            }
          : {}),
      });
      setDone(result.message);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not record your answer.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Loader2 className="h-8 w-8 animate-spin text-[#356AF6]" />
      </main>
    );
  }

  if (error || !job) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[#D9E3F3] bg-white p-8 text-center">
          <TriangleAlert className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-[#111827]">We could not open this link</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">{error}</p>
        </div>
      </main>
    );
  }

  if (done || alreadyConfirmed) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[#D9E3F3] bg-white p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-[#111827]">Thank you</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">
            {done || "You have already answered for this job. Contact the provider if anything has changed."}
          </p>
          <p className="mt-4 text-xs text-[#8794A8]">
            {job.reference} · {job.providerName}
          </p>
        </div>
      </main>
    );
  }

  const completedOn = formatDate(job.completedOn);

  return (
    <main className="min-h-screen bg-[#F7FAFF] px-4 py-10">
      <div className="mx-auto w-full max-w-xl space-y-5">
        <section className="rounded-2xl border border-[#D9E3F3] bg-white p-6">
          <h1 className="text-2xl font-bold text-[#111827]">Was the work completed?</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">
            {job.customerName ? `Hello ${job.customerName}, ` : ""}
            <strong>{job.providerName}</strong> has marked this work as completed
            {completedOn ? ` on ${completedOn}` : ""}. Please tell us how it went.
          </p>

          <div className="mt-4 rounded-xl bg-[#F7FAFF] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">The work</p>
            <p className="mt-1 font-semibold text-[#111827]">{job.jobName}</p>
            {job.description ? (
              <p className="mt-1 text-sm text-[#5E6F8A]">{job.description}</p>
            ) : null}
            <p className="mt-2 text-xs text-[#8794A8]">Reference {job.reference}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-[#D9E3F3] bg-white p-6">
          <fieldset>
            <legend className="text-sm font-medium text-[#111827]">Choose one</legend>
            <div className="mt-3 space-y-2">
              {OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition ${
                    outcome === option.value
                      ? option.tone === "positive"
                        ? "border-emerald-500 bg-emerald-50"
                        : option.tone === "negative"
                          ? "border-rose-400 bg-rose-50"
                          : "border-amber-400 bg-amber-50"
                      : "border-[#D9E3F3] hover:bg-[#F7FAFF]"
                  }`}
                >
                  <input
                    type="radio"
                    name="outcome"
                    value={option.value}
                    checked={outcome === option.value}
                    onChange={() => setOutcome(option.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-[#111827]">{option.label}</span>
                    <span className="block text-xs text-[#5E6F8A]">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {outcome && outcome !== "completed_satisfactorily" ? (
            <p className="mt-4 rounded-xl bg-[#FFF7E6] px-4 py-3 text-sm text-[#8A5A00]">
              An administrator will look into this and may contact you. You do not need to do
              anything else.
            </p>
          ) : null}

          {/* The satisfaction survey. Shown once an outcome is chosen, so the
              customer answers the question that matters first. */}
          {outcome ? (
            <div className="mt-6 border-t border-[#E6EDF9] pt-5">
              <p className="text-sm font-medium text-[#111827]">
                How would you rate the service overall?{" "}
                <span className="font-normal text-[#5E6F8A]">(optional)</span>
              </p>

              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Overall rating">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={overallRating === value}
                    onClick={() => setOverallRating(overallRating === value ? null : value)}
                    className={`h-11 w-11 rounded-xl border text-sm font-semibold transition ${
                      overallRating !== null && value <= overallRating
                        ? "border-[#356AF6] bg-[#356AF6] text-white"
                        : "border-[#D9E3F3] text-[#5E6F8A] hover:bg-[#F7FAFF]"
                    }`}
                  >
                    {value}
                  </button>
                ))}
                <span className="self-center text-xs text-[#8794A8]">
                  {overallRating ? `${overallRating} of 5` : "1 = poor, 5 = excellent"}
                </span>
              </div>

              {overallRating ? (
                <>
                  <button
                    type="button"
                    onClick={() => setShowDetail((open) => !open)}
                    className="mt-3 text-sm font-medium text-[#356AF6] underline"
                  >
                    {showDetail ? "Hide the extra questions" : "Answer a few more (optional)"}
                  </button>

                  {showDetail ? (
                    <div className="mt-3 space-y-4 rounded-xl bg-[#F7FAFF] p-4">
                      {[
                        { key: "quality", label: "Quality of the work" },
                        { key: "timeliness", label: "Timeliness" },
                        { key: "professionalism", label: "Professionalism" },
                        { key: "communication", label: "Communication" },
                      ].map((row) => (
                        <div key={row.key} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-[#111827]">{row.label}</span>
                          <span className="flex gap-1" role="group" aria-label={row.label}>
                            {[1, 2, 3, 4, 5].map((value) => (
                              <button
                                key={value}
                                type="button"
                                aria-pressed={detailRatings[row.key] === value}
                                onClick={() =>
                                  setDetailRatings((current) => {
                                    const next = { ...current };
                                    if (next[row.key] === value) delete next[row.key];
                                    else next[row.key] = value;
                                    return next;
                                  })
                                }
                                className={`h-8 w-8 rounded-lg border text-xs font-semibold ${
                                  detailRatings[row.key] !== undefined && value <= detailRatings[row.key]
                                    ? "border-[#356AF6] bg-[#356AF6] text-white"
                                    : "border-[#D9E3F3] text-[#5E6F8A]"
                                }`}
                              >
                                {value}
                              </button>
                            ))}
                          </span>
                        </div>
                      ))}

                      {[
                        { label: "Was the work as agreed?", value: scopeAsAgreed, set: setScopeAsAgreed },
                        { label: "Would you recommend this provider?", value: wouldRecommend, set: setWouldRecommend },
                        { label: "Would you use SmartLink again?", value: wouldUseAgain, set: setWouldUseAgain },
                      ].map((row) => (
                        <div key={row.label} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-[#111827]">{row.label}</span>
                          <span className="flex gap-2">
                            {[
                              { label: "Yes", answer: true },
                              { label: "No", answer: false },
                            ].map((option) => (
                              <button
                                key={option.label}
                                type="button"
                                aria-pressed={row.value === option.answer}
                                onClick={() => row.set(row.value === option.answer ? null : option.answer)}
                                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                                  row.value === option.answer
                                    ? "border-[#356AF6] bg-[#356AF6] text-white"
                                    : "border-[#D9E3F3] text-[#5E6F8A]"
                                }`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* The public review is opt-in and moderated. It is a
                      separate record from this survey, which stays
                      confidential. */}
                  <label className="mt-4 flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={publicReviewOptIn}
                      onChange={(event) => setPublicReviewOptIn(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-[#111827]">
                      Publish my rating and comment as a public review
                      <span className="block text-xs text-[#5E6F8A]">
                        Reviewed before it appears. Your other answers stay private either way.
                      </span>
                    </span>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4">
            <label htmlFor="comments" className="mb-1 block text-sm font-medium text-[#111827]">
              Anything you would like to add?{" "}
              <span className="font-normal text-[#5E6F8A]">(optional)</span>
            </label>
            <textarea
              id="comments"
              rows={3}
              value={comments}
              onChange={(event) => setComments(event.target.value)}
              maxLength={2000}
              className="w-full rounded-xl border border-[#D9E3F3] p-3 text-sm text-[#111827] focus:border-[#356AF6] focus:outline-none"
            />
          </div>

          {submitError ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
            >
              {submitError}
            </p>
          ) : null}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!outcome || submitting}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#356AF6] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2C59D8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Send my answer
          </button>
        </section>

        <p className="text-center text-xs text-[#8794A8]">
          SmartLink records the outcome of work arranged through the platform. Payment is arranged
          directly with {job.providerName}.
        </p>
      </div>
    </main>
  );
}
