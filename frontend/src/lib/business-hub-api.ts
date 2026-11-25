/**
 * Business Hub API client: cost estimates, quotations, invoices and jobs,
 * plus the customer-facing document endpoints.
 *
 * Separate from backend-api.ts because that file is already 450 lines covering
 * the marketplace, and these are a distinct feature area with their own types.
 */

import { clearAdminSession } from "@/lib/admin-session";
import type {
  CustomerInvoiceView,
  CustomerQuotationView,
  Invoice,
  Job,
  JobDateRevision,
  QuickCostEstimate,
  Quotation,
  QuotationInput,
} from "@/types";

const DEFAULT_API_BASE = "http://localhost:5000/api";

function apiBase() {
  return process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && typeof window !== "undefined") {
      clearAdminSession();
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login?expired=true";
      }
    }
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || text;
    } catch {
      /* non-JSON error body; the raw text is the best available message */
    }
    throw new Error(message || `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

/** Fetches a PDF as a Blob and hands the browser a download. */
async function downloadPdf(path: string, token: string, filename: string) {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not generate that PDF.");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked after the click so the browser has finished reading it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- QuickCost -------------------------------------------------------------

export interface QuickCostInput {
  jobName: string;
  customerSummary?: string;
  internalNotes?: string;
  costItems?: Array<{ kind: string; label: string; quantity: number; unitCost: number }>;
  overheadAmount?: number | null;
  targetMarginPercent?: number;
  finalPrice?: number | null;
  status?: string;
}

export async function listEstimates(token: string) {
  const res = await request<{ data: { estimates: QuickCostEstimate[] } }>("/hub/quickcost", token);
  return res.data.estimates || [];
}

export async function createEstimate(payload: QuickCostInput, token: string) {
  const res = await request<{ data: QuickCostEstimate }>("/hub/quickcost", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function updateEstimate(id: string, payload: QuickCostInput, token: string) {
  const res = await request<{ data: QuickCostEstimate }>(`/hub/quickcost/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function deleteEstimate(id: string, token: string) {
  return request<{ success: boolean }>(`/hub/quickcost/${id}`, token, { method: "DELETE" });
}

/**
 * Everything a quotation is allowed to know about a cost estimate.
 *
 * Cost, labour rates, overhead and margin are not in this response at all --
 * the server decides what crosses that boundary, not this client.
 */
export async function getQuoteBasis(id: string, token: string) {
  const res = await request<{
    data: { jobName: string; customerSummary: string | null; finalPrice: number; currency: string };
  }>(`/hub/quickcost/${id}/quote-basis`, token);
  return res.data;
}

// --- Quotations -------------------------------------------------------------

export async function listQuotations(token: string, status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await request<{ data: { quotations: Quotation[] } }>(
    `/hub/quotations${query}`,
    token,
  );
  return res.data.quotations || [];
}

export async function getQuotation(id: string, token: string) {
  const res = await request<{ data: Quotation }>(`/hub/quotations/${id}`, token);
  return res.data;
}

export async function createQuotation(payload: QuotationInput, token: string) {
  const res = await request<{ data: Quotation }>("/hub/quotations", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function updateQuotation(id: string, payload: QuotationInput, token: string) {
  const res = await request<{ data: Quotation }>(`/hub/quotations/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function sendQuotation(id: string, token: string) {
  return request<{
    message: string;
    data: { quotation: Quotation; customerUrl: string; delivered: boolean };
  }>(`/hub/quotations/${id}/send`, token, { method: "POST" });
}

export async function extendQuotationValidity(id: string, additionalDays: number, token: string) {
  const res = await request<{ data: Quotation }>(`/hub/quotations/${id}/extend`, token, {
    method: "POST",
    body: JSON.stringify({ additionalDays }),
  });
  return res.data;
}

export async function reviseQuotation(id: string, token: string) {
  const res = await request<{ data: Quotation }>(`/hub/quotations/${id}/revise`, token, {
    method: "POST",
  });
  return res.data;
}

export async function deleteQuotation(id: string, token: string) {
  return request<{ success: boolean }>(`/hub/quotations/${id}`, token, { method: "DELETE" });
}

export async function downloadQuotationPdf(id: string, reference: string, token: string) {
  return downloadPdf(`/hub/quotations/${id}/pdf`, token, `${reference}.pdf`);
}

// --- Invoices ----------------------------------------------------------------

export async function listInvoices(token: string) {
  const res = await request<{ data: { invoices: Invoice[] } }>("/hub/invoices", token);
  return res.data.invoices || [];
}

export async function createInvoiceFromQuotation(
  quotationId: string,
  payload: { depositAmount?: number; dueInDays?: number; paymentTerms?: string; paymentInstructions?: string },
  token: string,
) {
  const res = await request<{ data: Invoice }>(
    `/hub/invoices/from-quotation/${quotationId}`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return res.data;
}

export async function sendInvoice(id: string, token: string) {
  return request<{
    message: string;
    data: { invoice: Invoice; customerUrl: string; delivered: boolean };
  }>(`/hub/invoices/${id}/send`, token, { method: "POST" });
}

export async function cancelInvoice(id: string, reason: string, token: string) {
  const res = await request<{ data: Invoice }>(`/hub/invoices/${id}/cancel`, token, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  return res.data;
}

export async function recordPayment(
  id: string,
  payload: { amount: number; paidOn?: string; method?: string; reference?: string; notes?: string },
  token: string,
) {
  const res = await request<{ data: Invoice }>(`/hub/invoices/${id}/payments`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function deletePayment(invoiceId: string, paymentId: string, token: string) {
  const res = await request<{ data: Invoice }>(
    `/hub/invoices/${invoiceId}/payments/${paymentId}`,
    token,
    { method: "DELETE" },
  );
  return res.data;
}

export async function downloadInvoicePdf(id: string, reference: string, token: string) {
  return downloadPdf(`/hub/invoices/${id}/pdf`, token, `${reference}.pdf`);
}

// --- Jobs ----------------------------------------------------------------------

export async function listJobs(token: string, status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await request<{ data: { jobs: Job[] } }>(`/hub/jobs${query}`, token);
  return res.data.jobs || [];
}

export async function createManualJob(
  payload: {
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    jobName: string;
    description?: string;
    agreedPrice?: number | null;
    expectedCompletionDate?: string | null;
  },
  token: string,
) {
  const res = await request<{ data: Job }>("/hub/jobs", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function createJobFromQuotation(
  quotationId: string,
  expectedCompletionDate: string | null,
  token: string,
) {
  const res = await request<{ data: Job }>(`/hub/jobs/from-quotation/${quotationId}`, token, {
    method: "POST",
    body: JSON.stringify({ expectedCompletionDate }),
  });
  return res.data;
}

export async function updateJobStatus(
  id: string,
  payload: { status: string; actualCompletionDate?: string | null; notes?: string },
  token: string,
) {
  const res = await request<{ data: Job }>(`/hub/jobs/${id}/status`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function reviseJobDate(
  id: string,
  payload: { requestedDate: string; reason: string },
  token: string,
) {
  return request<{
    message: string;
    data: { job: Job; revision: JobDateRevision; requiresApproval: boolean };
  }>(`/hub/jobs/${id}/revise-date`, token, { method: "POST", body: JSON.stringify(payload) });
}

export async function listJobDateRevisions(id: string, token: string) {
  const res = await request<{ data: { revisions: JobDateRevision[] } }>(
    `/hub/jobs/${id}/date-revisions`,
    token,
  );
  return res.data.revisions || [];
}

// --- Customer document access (no session) ---------------------------------------

/**
 * The token travels in a header, never a query string.
 *
 * The server logs full request URLs, so a token in the query string would be
 * written into the access log on every request. The page reads it from the URL
 * fragment, which is never sent to any server.
 */
async function documentRequest<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase()}/documents${path}`, {
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

export async function fetchCustomerQuotation(token: string) {
  const res = await documentRequest<{
    data: {
      quotation: CustomerQuotationView;
      requiresCode: boolean;
      codeVerified: boolean;
      canRespond: boolean;
    };
  }>("/quotation", token);
  return res.data;
}

export async function resendCustomerQuotationCode(token: string) {
  return documentRequest<{ message: string; data: { delivered: boolean } }>(
    "/quotation/code",
    token,
  );
}

export async function respondToCustomerQuotation(
  token: string,
  payload: { decision: "approve" | "decline" | "request_changes"; code: string; message?: string; acceptedTerms?: boolean },
) {
  return documentRequest<{ message: string; data: { status: string; reference: string } }>(
    "/quotation/respond",
    token,
    payload,
  );
}

export async function fetchCustomerInvoice(token: string) {
  const res = await documentRequest<{ data: { invoice: CustomerInvoiceView } }>("/invoice", token);
  return res.data.invoice;
}

/** Customer-side PDF download. Same header rule as every other document call. */
export async function downloadCustomerPdf(
  kind: "quotation" | "invoice",
  token: string,
  reference: string,
) {
  const response = await fetch(`${apiBase()}/documents/${kind}/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Document-Token": token },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error("Could not download that document.");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${reference}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Shared money formatting, matching the server's. */
export function formatMoney(amount: number | null | undefined, currency = "USD") {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const value = Number(amount || 0);
  const sign = value < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
