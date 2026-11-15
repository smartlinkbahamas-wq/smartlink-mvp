import { getAdminAccessToken } from "@/lib/admin-session";
import { getMyExpertApplicationStatus } from "@/lib/backend-api";

const ADMIN_ROLES = ["super_admin", "admin", "moderator", "auditor"];

// Where a person belongs once they are signed in. Shared by the login page and
// the MFA page so both land people in the same place.
export async function resolveLandingPath(resolvedRole?: string): Promise<string> {
  const role = String(resolvedRole || "");

  if (ADMIN_ROLES.includes(role)) return "/admin";

  if (role === "expert") {
    // An approved expert belongs in their workspace, not on the application
    // status page they cleared long ago. Anything else (pending, needs_info,
    // rejected, or an unreadable status) still goes to the status page.
    try {
      const token = getAdminAccessToken();
      if (!token) return "/expert-application-status";
      const statusView = await getMyExpertApplicationStatus(token);
      return statusView?.application?.status === "approved"
        ? "/expert-dashboard"
        : "/expert-application-status";
    } catch {
      return "/expert-application-status";
    }
  }

  return "/";
}

// The MFA page is reached by redirect, so the ticket has to survive a
// navigation. sessionStorage clears when the tab closes, which is the right
// lifetime for a half-finished sign-in.
const MFA_KEY = "smartlink:mfa-challenge";

export type MfaChallenge = {
  ticket: string;
  methods: string[];
  email?: string;
};

export function stashMfaChallenge(challenge: MfaChallenge) {
  try {
    sessionStorage.setItem(MFA_KEY, JSON.stringify(challenge));
  } catch {
    // Private browsing can refuse storage; the MFA page then sends them back
    // to /login rather than showing a broken form.
  }
}

export function readMfaChallenge(): MfaChallenge | null {
  try {
    const raw = sessionStorage.getItem(MFA_KEY);
    return raw ? (JSON.parse(raw) as MfaChallenge) : null;
  } catch {
    return null;
  }
}

export function clearMfaChallenge() {
  try {
    sessionStorage.removeItem(MFA_KEY);
  } catch {
    // Nothing to do.
  }
}
