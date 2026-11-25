const PDFDocument = require("pdfkit");

const { formatAmount } = require("../utils/money");

/**
 * Quotation and invoice PDFs.
 *
 * pdfkit rather than headless Chrome: this runs on a small VPS alongside the
 * API, and a browser-based renderer would pull several hundred megabytes of
 * Chromium and a process per render. A quotation is a table and some headings;
 * it does not need a browser.
 *
 * Rendered to a Buffer rather than a file. These documents contain customer
 * details and prices, and writing them to disk on a server with no per-file
 * access control would create exactly the exposure the uploads directory
 * already has.
 */

const PAGE_MARGIN = 50;
const COLOURS = {
  ink: "#111827",
  muted: "#6B7280",
  rule: "#D9E3F3",
  accent: "#2E67E8",
};

function money(amount, currency) {
  return formatAmount(amount, currency);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function drawRule(doc, y) {
  doc
    .strokeColor(COLOURS.rule)
    .lineWidth(1)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .stroke();
}

/** The issuing business, from the snapshot taken when the document was sent. */
function drawHeader(doc, { title, reference, business, status }) {
  doc.fillColor(COLOURS.ink).fontSize(24).font("Helvetica-Bold").text(title, PAGE_MARGIN, PAGE_MARGIN);

  doc.fontSize(10).font("Helvetica").fillColor(COLOURS.muted);
  doc.text(reference, PAGE_MARGIN, doc.y + 2);
  if (status) doc.text(status, PAGE_MARGIN, doc.y + 2);

  const rightX = doc.page.width / 2;
  const top = PAGE_MARGIN;

  if (business) {
    doc.fontSize(11).font("Helvetica-Bold").fillColor(COLOURS.ink);
    doc.text(business.business_name || "", rightX, top, { width: doc.page.width - rightX - PAGE_MARGIN, align: "right" });

    doc.fontSize(9).font("Helvetica").fillColor(COLOURS.muted);
    const lines = [
      business.address,
      business.phone,
      business.email,
      business.website,
      // Printed only when the provider is actually registered. The database
      // will not allow registered-without-a-number, so this cannot print a
      // claim of registration with no number behind it.
      business.vat_registered && business.vat_number ? `VAT No. ${business.vat_number}` : null,
    ].filter(Boolean);

    for (const line of lines) {
      doc.text(String(line), rightX, doc.y + 1, {
        width: doc.page.width - rightX - PAGE_MARGIN,
        align: "right",
      });
    }
  }

  const y = Math.max(doc.y, top + 70) + 12;
  drawRule(doc, y);
  doc.y = y + 16;
}

function drawCustomer(doc, { customerName, customerSummary, jobName, meta = [] }) {
  const startY = doc.y;

  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.muted).text("PREPARED FOR", PAGE_MARGIN, startY);
  doc.fontSize(12).font("Helvetica-Bold").fillColor(COLOURS.ink).text(customerName || "—", PAGE_MARGIN, doc.y + 2);

  const rightX = doc.page.width / 2;
  let metaY = startY;
  for (const [label, value] of meta) {
    doc.fontSize(9).font("Helvetica").fillColor(COLOURS.muted);
    doc.text(`${label}: `, rightX, metaY, { width: doc.page.width - rightX - PAGE_MARGIN, align: "right", continued: false });
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.ink);
    doc.text(String(value), rightX, doc.y, { width: doc.page.width - rightX - PAGE_MARGIN, align: "right" });
    metaY = doc.y + 4;
  }

  doc.y = Math.max(doc.y, metaY) + 12;
  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.muted).text("WORK", PAGE_MARGIN, doc.y);
  doc.fontSize(12).font("Helvetica-Bold").fillColor(COLOURS.ink).text(jobName || "—", PAGE_MARGIN, doc.y + 2);

  if (customerSummary) {
    doc.fontSize(10).font("Helvetica").fillColor(COLOURS.muted).text(customerSummary, PAGE_MARGIN, doc.y + 4, {
      width: doc.page.width - PAGE_MARGIN * 2,
    });
  }

  doc.y += 16;
}

/**
 * The line table.
 *
 * Informational lines are printed with their value and no figures, so a
 * florist's event date or flower colours appear on the document without
 * implying a charge.
 */
function drawLineItems(doc, lineItems, currency) {
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const qtyX = right - 230;
  const unitX = right - 150;
  const totalX = right - 70;

  doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.muted);
  const headerY = doc.y;
  doc.text("DESCRIPTION", left, headerY);
  doc.text("QTY", qtyX, headerY, { width: 60, align: "right" });
  doc.text("UNIT", unitX, headerY, { width: 70, align: "right" });
  doc.text("AMOUNT", totalX, headerY, { width: 70, align: "right" });

  doc.y = headerY + 14;
  drawRule(doc, doc.y);
  doc.y += 8;

  for (const item of lineItems || []) {
    // A new page before the row rather than halfway through it, so a
    // description never splits across the page break from its amount.
    if (doc.y > doc.page.height - 160) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
    }

    const rowY = doc.y;
    doc.fontSize(10).font("Helvetica").fillColor(COLOURS.ink);
    doc.text(item.label || "—", left, rowY, { width: qtyX - left - 10 });

    if (item.informational) {
      doc.fontSize(9).font("Helvetica-Oblique").fillColor(COLOURS.muted);
      doc.text(item.value || "Noted", qtyX, rowY, { width: totalX + 70 - qtyX, align: "right" });
    } else {
      doc.fontSize(10).font("Helvetica").fillColor(COLOURS.ink);
      doc.text(String(item.quantity ?? 1), qtyX, rowY, { width: 60, align: "right" });
      doc.text(money(item.unitPrice ?? 0, currency), unitX, rowY, { width: 70, align: "right" });
      doc.font("Helvetica-Bold").text(money(item.lineTotal ?? 0, currency), totalX, rowY, {
        width: 70,
        align: "right",
      });
    }

    let bottom = doc.y;
    if (item.description) {
      doc.fontSize(9).font("Helvetica").fillColor(COLOURS.muted);
      doc.text(item.description, left, bottom + 2, { width: qtyX - left - 10 });
      bottom = doc.y;
    }

    doc.y = bottom + 8;
  }

  drawRule(doc, doc.y);
  doc.y += 10;
}

function drawTotals(doc, rows, currency) {
  const right = doc.page.width - PAGE_MARGIN;
  const labelX = right - 260;
  const valueX = right - 90;

  for (const [label, value, emphasis] of rows) {
    if (value === null || value === undefined) continue;

    const y = doc.y;
    doc
      .fontSize(emphasis ? 12 : 10)
      .font(emphasis ? "Helvetica-Bold" : "Helvetica")
      .fillColor(emphasis ? COLOURS.ink : COLOURS.muted);
    doc.text(label, labelX, y, { width: 160, align: "right" });
    doc
      .fontSize(emphasis ? 12 : 10)
      .font("Helvetica-Bold")
      .fillColor(emphasis ? COLOURS.accent : COLOURS.ink);
    doc.text(typeof value === "number" ? money(value, currency) : String(value), valueX, y, {
      width: 90,
      align: "right",
    });
    doc.y = y + (emphasis ? 20 : 16);
  }
}

function drawFooter(doc, { terms, note }) {
  if (terms) {
    if (doc.y > doc.page.height - 140) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
    }
    doc.y += 10;
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.muted).text("TERMS", PAGE_MARGIN, doc.y);
    doc.fontSize(9).font("Helvetica").fillColor(COLOURS.ink).text(terms, PAGE_MARGIN, doc.y + 4, {
      width: doc.page.width - PAGE_MARGIN * 2,
    });
  }

  if (note) {
    doc.y += 12;
    doc.fontSize(8).font("Helvetica").fillColor(COLOURS.muted).text(note, PAGE_MARGIN, doc.y, {
      width: doc.page.width - PAGE_MARGIN * 2,
    });
  }
}

/** Collects the stream into a Buffer. */
function render(build) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      build(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function renderQuotationPdf(quotation) {
  const currency = quotation.currency || "USD";

  return render((doc) => {
    drawHeader(doc, {
      title: "Quotation",
      reference: `${quotation.reference}${quotation.version > 1 ? ` · version ${quotation.version}` : ""}`,
      business: quotation.business_identity,
      status: quotation.status === "approved" ? "Approved" : null,
    });

    drawCustomer(doc, {
      customerName: quotation.customer_name,
      customerSummary: quotation.customer_summary,
      jobName: quotation.job_name,
      meta: [
        ["Date", formatDate(quotation.sent_at || quotation.created_at)],
        ["Valid until", formatDate(quotation.valid_until)],
      ],
    });

    drawLineItems(doc, quotation.line_items, currency);

    drawTotals(
      doc,
      [
        ["Subtotal", Number(quotation.subtotal)],
        // Printed only when there is one, and the reason goes next to it so a
        // customer can see why the figure changed.
        Number(quotation.discount_total) > 0
          ? [
              `Discount${quotation.discount_reason ? ` (${quotation.discount_reason})` : ""}`,
              -Number(quotation.discount_total),
            ]
          : [null, null],
        Number(quotation.tax_rate_percent) > 0
          ? [`${quotation.tax_label} (${Number(quotation.tax_rate_percent)}%)`, Number(quotation.tax_amount)]
          : [null, null],
        Number(quotation.additional_costs) > 0
          ? [quotation.additional_costs_label, Number(quotation.additional_costs)]
          : [null, null],
        ["Total", Number(quotation.total), true],
      ].filter(([label]) => label !== null),
      currency,
    );

    drawFooter(doc, {
      terms: quotation.terms,
      note: `This quotation is valid until ${formatDate(quotation.valid_until)}. Prices and scope are as set out above.`,
    });
  });
}

async function renderInvoicePdf(invoice, payments = [], summary = null) {
  const currency = invoice.currency || "USD";
  const paid = summary?.paid ?? 0;
  const balance = summary?.balance ?? Number(invoice.total);

  return render((doc) => {
    drawHeader(doc, {
      title: "Invoice",
      reference: invoice.reference,
      business: invoice.business_identity,
      status: summary?.displayStatus || null,
    });

    drawCustomer(doc, {
      customerName: invoice.customer_name,
      customerSummary: invoice.customer_summary,
      jobName: invoice.job_name,
      meta: [
        ["Issued", formatDate(invoice.issue_date)],
        ["Due", formatDate(invoice.due_date)],
        invoice.quotation_reference ? ["Quotation", invoice.quotation_reference] : null,
      ].filter(Boolean),
    });

    drawLineItems(doc, invoice.line_items, currency);

    drawTotals(
      doc,
      [
        ["Subtotal", Number(invoice.subtotal)],
        Number(invoice.discount_total) > 0
          ? [
              `Discount${invoice.discount_reason ? ` (${invoice.discount_reason})` : ""}`,
              -Number(invoice.discount_total),
            ]
          : [null, null],
        Number(invoice.tax_rate_percent) > 0
          ? [`${invoice.tax_label} (${Number(invoice.tax_rate_percent)}%)`, Number(invoice.tax_amount)]
          : [null, null],
        Number(invoice.additional_costs) > 0
          ? [invoice.additional_costs_label, Number(invoice.additional_costs)]
          : [null, null],
        ["Total", Number(invoice.total), true],
        paid > 0 ? ["Paid to date", -paid] : [null, null],
        ["Balance due", balance, true],
      ].filter(([label]) => label !== null),
      currency,
    );

    if (payments.length > 0) {
      doc.y += 6;
      doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOURS.muted).text("PAYMENTS RECEIVED", PAGE_MARGIN, doc.y);
      doc.y += 4;
      for (const payment of payments) {
        doc.fontSize(9).font("Helvetica").fillColor(COLOURS.ink);
        doc.text(
          `${formatDate(payment.paid_on)}${payment.method ? ` · ${payment.method}` : ""} — ${money(payment.amount, currency)}`,
          PAGE_MARGIN,
          doc.y + 2,
        );
      }
    }

    drawFooter(doc, {
      terms: invoice.payment_instructions
        ? `${invoice.payment_terms ? `${invoice.payment_terms}\n` : ""}${invoice.payment_instructions}`
        : invoice.payment_terms,
      note: invoice.terms || null,
    });
  });
}

module.exports = {
  renderQuotationPdf,
  renderInvoicePdf,
};
