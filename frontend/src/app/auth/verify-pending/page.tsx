"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Mail, MailCheck, RefreshCw, TriangleAlert } from "lucide-react";

import { resendVerification } from "@/lib/admin-session";

// What the page is showing right now. "manual" is the local/staging case where
// SMTP is off and the only way through is the raw link.
type View = "form" | "sent" | "manual" | "verified";

const RESEND_COOLDOWN_SECONDS = 30;

function formatVerificationLink(link: string | null): string {
  if (!link || typeof window === "undefined") return link || "";
  try {
    const url = new URL(link);
    if (url.searchParams.has("redirect_to")) {
      url.searchParams.set("redirect_to", `${window.location.origin}/login?verified=true`);
    }
    return url.toString();
  } catch {
    return link;
  }
}

export default function VerifyPendingPage() {
  const [email, setEmail] = useState("");
  const [view, setView] = useState<View>("form");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verificationLink, setVerificationLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const triggerResend = useCallback(async (targetEmail: string) => {
    if (!targetEmail) return;
    setLoading(true);
    setError("");

    try {
      const result = await resendVerification(
        targetEmail.trim(),
        typeof window !== "undefined" ? `${window.location.origin}/login?verified=true` : undefined,
      );

      if (result.alreadyVerified) {
        setView("verified");
        return;
      }

      // The server tells us whether the mail actually went out. Only when it
      // did not do we fall back to handing over the link, so a working mail
      // setup never shows a "not configured" warning.
      if (result.delivered) {
        setVerificationLink(null);
        setView("sent");
        setCooldown(RESEND_COOLDOWN_SECONDS);
        return;
      }

      if (result.verificationLink) {
        setVerificationLink(result.verificationLink);
        setView("manual");
        return;
      }

      setError("We could not send the verification email just now. Please try again in a moment.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send the verification email.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const queryEmail = new URLSearchParams(window.location.search).get("email");
    if (queryEmail) {
      setEmail(queryEmail);
      triggerResend(queryEmail);
    }
  }, [triggerResend]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await triggerResend(email);
  };

  const formattedLink = useMemo(() => formatVerificationLink(verificationLink), [verificationLink]);

  const handleCopyLink = async () => {
    if (!formattedLink) return;
    try {
      await navigator.clipboard.writeText(formattedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard access can be refused; the link is selectable either way.
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(140deg,#f7fbff_0%,#eef4ff_45%,#f9f6ff_100%)] px-4 py-10">
      <div className="pointer-events-none absolute left-[-140px] top-[-120px] h-[340px] w-[340px] rounded-full bg-[radial-gradient(circle,#9fc7ff_0%,rgba(159,199,255,0)_70%)]" />
      <div className="pointer-events-none absolute bottom-[-140px] right-[-100px] h-[300px] w-[300px] rounded-full bg-[radial-gradient(circle,#c7b6ff_0%,rgba(199,182,255,0)_72%)]" />

      <div className="relative w-full max-w-[460px]">
        <div className="rounded-[28px] border border-white/70 bg-white/90 p-8 shadow-[0_24px_60px_rgba(42,67,113,0.14)] backdrop-blur">
          {view === "verified" ? (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(145deg,#10b981,#059669)] shadow-[0_10px_24px_rgba(16,185,129,0.3)]">
                <CheckCircle2 className="h-7 w-7 text-white" />
              </div>
              <h1 className="mt-5 text-center text-[1.6rem] font-bold leading-tight text-[#0f172a]">
                You&apos;re all set
              </h1>
              <p className="mt-2 text-center text-sm leading-6 text-[#5b6b85]">
                <span className="font-semibold text-[#0f172a]">{email}</span> is already verified.
              </p>
              <Link
                href="/login?verified=true"
                className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] text-[0.95rem] font-semibold text-white shadow-[0_12px_30px_rgba(59,97,240,0.32)] transition hover:brightness-105"
              >
                Continue to sign in
              </Link>
            </>
          ) : view === "sent" ? (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] shadow-[0_10px_24px_rgba(59,97,240,0.32)]">
                <MailCheck className="h-7 w-7 text-white" />
              </div>
              <h1 className="mt-5 text-center text-[1.6rem] font-bold leading-tight text-[#0f172a]">
                Check your inbox
              </h1>
              <p className="mt-2 text-center text-sm leading-6 text-[#5b6b85]">
                We sent a verification link to{" "}
                <span className="font-semibold text-[#0f172a]">{email}</span>. Open it to activate
                your account.
              </p>

              <div className="mt-6 rounded-2xl border border-[#dbe6f8] bg-[#f5f9ff] px-4 py-3.5 text-[13px] leading-5 text-[#4a5a75]">
                Can&apos;t find it? Give it a minute, then look in your spam or promotions folder.
              </div>

              {error ? (
                <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                  {error}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => triggerResend(email)}
                disabled={loading || cooldown > 0}
                className="mx-auto mt-5 flex items-center gap-1.5 text-xs font-semibold text-[#2563eb] transition hover:text-[#1d4ed8] disabled:cursor-not-allowed disabled:text-[#9aa7bd]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {loading ? "Sending..." : cooldown > 0 ? `Resend in ${cooldown}s` : "Send it again"}
              </button>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] shadow-[0_10px_24px_rgba(59,97,240,0.32)]">
                <Mail className="h-7 w-7 text-white" />
              </div>
              <h1 className="mt-5 text-center text-[1.6rem] font-bold leading-tight text-[#0f172a]">
                Verify your email
              </h1>
              <p className="mt-2 text-center text-sm leading-6 text-[#5b6b85]">
                Enter your account email and we&apos;ll send the verification link again.
              </p>

              <form onSubmit={onSubmit} className="mt-6 space-y-3">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  placeholder="name@example.com"
                  className="h-12 w-full rounded-2xl border border-[#d9e3f3] bg-white px-4 text-sm text-[#0f172a] outline-none transition placeholder:text-[#a9b6cc] focus:border-[#2563eb] focus:ring-4 focus:ring-[#2563eb]/12"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="h-12 w-full rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] text-[0.95rem] font-semibold text-white shadow-[0_12px_30px_rgba(59,97,240,0.32)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Sending..." : "Send verification link"}
                </button>
              </form>

              {error ? (
                <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                  {error}
                </p>
              ) : null}

              {/* Only reached when the server could not deliver the mail but did
                  produce a link — a local or staging box with SMTP switched off. */}
              {view === "manual" && formattedLink ? (
                <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
                  <div className="flex items-start gap-3">
                    <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold text-amber-900">
                        We couldn&apos;t email the link
                      </h2>
                      <p className="mt-1 text-xs leading-relaxed text-amber-800">
                        Mail delivery is unavailable on this environment. Use the link below to
                        verify your account directly.
                      </p>
                      <div className="mt-3 select-all break-all rounded-lg border border-amber-200 bg-white p-2.5 font-mono text-xs text-slate-700">
                        {formattedLink}
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleCopyLink}
                          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700"
                        >
                          {copied ? "Link copied" : "Copy link"}
                        </button>
                        <a
                          href={formattedLink}
                          className="rounded-lg bg-[#2563eb] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1d4ed8]"
                        >
                          Verify now
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <Link
          href="/login"
          className="mx-auto mt-6 flex w-fit items-center text-sm font-medium text-[#5b6b85] transition hover:text-[#0f172a]"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
