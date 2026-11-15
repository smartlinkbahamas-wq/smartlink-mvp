"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KeyRound, Mail, ShieldCheck, ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { sendEmailOtp, verifyEmailOtp, verifyTotpChallenge } from "@/lib/admin-session";
import { clearMfaChallenge, readMfaChallenge, resolveLandingPath } from "@/lib/post-login";

type Mode = "totp" | "email_otp";

const CODE_LENGTH = 6;

export default function MfaPage() {
  const router = useRouter();

  const [ticket, setTicket] = useState("");
  const [methods, setMethods] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [ready, setReady] = useState(false);

  const [mode, setMode] = useState<Mode>("email_otp");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  const hasTotp = useMemo(() => methods.includes("totp"), [methods]);

  // The challenge was stashed by the login page before redirecting here. No
  // challenge means someone opened this URL directly, so send them back.
  useEffect(() => {
    const challenge = readMfaChallenge();
    if (!challenge?.ticket) {
      router.replace("/login");
      return;
    }
    setTicket(challenge.ticket);
    setMethods(challenge.methods || []);
    setEmail(challenge.email || "");
    setMode(challenge.methods?.includes("totp") ? "totp" : "email_otp");
    setReady(true);
  }, [router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready, mode]);

  const maskedEmail = useMemo(() => {
    if (!email.includes("@")) return email;
    const [name, domain] = email.split("@");
    const shown = name.slice(0, 2);
    return `${shown}${"•".repeat(Math.max(name.length - 2, 2))}@${domain}`;
  }, [email]);

  const onSendOtp = async () => {
    setSending(true);
    setError("");
    setMessage("");
    try {
      await sendEmailOtp(ticket);
      setOtpSent(true);
      setCooldown(30);
      setMessage(`We sent a ${CODE_LENGTH}-digit code to ${maskedEmail || "your email"}.`);
      inputRef.current?.focus();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send the code. Try again.");
    } finally {
      setSending(false);
    }
  };

  const onVerify = async () => {
    if (code.length !== CODE_LENGTH) return;
    setLoading(true);
    setError("");
    try {
      const result =
        mode === "totp"
          ? await verifyTotpChallenge(ticket, code)
          : await verifyEmailOtp(ticket, code);

      clearMfaChallenge();
      router.push(await resolveLandingPath(result.role));
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "That code was not accepted.");
      setCode("");
      inputRef.current?.focus();
      setLoading(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setCode("");
    setError("");
    setMessage("");
  };

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[linear-gradient(140deg,#f7fbff_0%,#eef4ff_45%,#f9f6ff_100%)]">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(140deg,#f7fbff_0%,#eef4ff_45%,#f9f6ff_100%)] px-4 py-10">
      <div className="pointer-events-none absolute left-[-140px] top-[-120px] h-[340px] w-[340px] rounded-full bg-[radial-gradient(circle,#9fc7ff_0%,rgba(159,199,255,0)_70%)]" />
      <div className="pointer-events-none absolute bottom-[-140px] right-[-100px] h-[300px] w-[300px] rounded-full bg-[radial-gradient(circle,#c7b6ff_0%,rgba(199,182,255,0)_72%)]" />

      <div className="relative w-full max-w-[440px]">
        <div className="rounded-[28px] border border-white/70 bg-white/90 p-8 shadow-[0_24px_60px_rgba(42,67,113,0.14)] backdrop-blur">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] shadow-[0_10px_24px_rgba(59,97,240,0.32)]">
            <ShieldCheck className="h-7 w-7 text-white" />
          </div>

          <h1 className="mt-5 text-center text-[1.6rem] font-bold leading-tight text-[#0f172a]">
            Verify it&apos;s you
          </h1>
          <p className="mt-2 text-center text-sm leading-6 text-[#5b6b85]">
            {mode === "totp"
              ? "Open your authenticator app and enter the 6-digit code."
              : otpSent
                ? `Enter the code we sent to ${maskedEmail}.`
                : "We'll email you a one-time code to finish signing in."}
          </p>

          {hasTotp ? (
            <div className="mt-6 grid grid-cols-2 gap-1 rounded-2xl bg-[#eef3fb] p-1">
              <button
                type="button"
                onClick={() => switchMode("totp")}
                className={`flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition ${
                  mode === "totp" ? "bg-white text-[#1d4ed8] shadow-sm" : "text-[#5b6b85]"
                }`}
              >
                <KeyRound className="h-4 w-4" />
                Authenticator
              </button>
              <button
                type="button"
                onClick={() => switchMode("email_otp")}
                className={`flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition ${
                  mode === "email_otp" ? "bg-white text-[#1d4ed8] shadow-sm" : "text-[#5b6b85]"
                }`}
              >
                <Mail className="h-4 w-4" />
                Email code
              </button>
            </div>
          ) : null}

          {error ? (
            <p className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          {message && !error ? (
            <p className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
              {message}
            </p>
          ) : null}

          {/* Email-only accounts ask for the code before showing the input, so
              nobody stares at an empty box wondering what to type. */}
          {mode === "email_otp" && !otpSent ? (
            <Button
              type="button"
              onClick={onSendOtp}
              disabled={sending}
              className="mt-6 h-12 w-full rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] text-[0.95rem] font-semibold text-white shadow-[0_12px_30px_rgba(59,97,240,0.32)] hover:brightness-105"
            >
              <Mail className="mr-2 h-4 w-4" />
              {sending ? "Sending..." : "Email me a code"}
            </Button>
          ) : (
            <>
              <input
                ref={inputRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onVerify();
                }}
                placeholder="------"
                className="mt-6 h-16 w-full rounded-2xl border border-[#d9e3f3] bg-white text-center font-mono text-[28px] font-bold tracking-[14px] text-[#0f172a] outline-none transition placeholder:text-[#c7d3e6] focus:border-[#2563eb] focus:ring-4 focus:ring-[#2563eb]/12"
              />

              <Button
                type="button"
                onClick={onVerify}
                disabled={loading || code.length !== CODE_LENGTH}
                className="mt-4 h-12 w-full rounded-2xl bg-[linear-gradient(145deg,#2563eb,#4f46e5)] text-[0.95rem] font-semibold text-white shadow-[0_12px_30px_rgba(59,97,240,0.32)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Verify and continue"}
              </Button>

              {mode === "email_otp" ? (
                <button
                  type="button"
                  onClick={onSendOtp}
                  disabled={sending || cooldown > 0}
                  className="mx-auto mt-4 flex items-center gap-1.5 text-xs font-semibold text-[#2563eb] transition hover:text-[#1d4ed8] disabled:cursor-not-allowed disabled:text-[#9aa7bd]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
                </button>
              ) : null}
            </>
          )}
        </div>

        <Link
          href="/login"
          onClick={clearMfaChallenge}
          className="mx-auto mt-6 flex w-fit items-center gap-1.5 text-sm font-medium text-[#5b6b85] transition hover:text-[#0f172a]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
