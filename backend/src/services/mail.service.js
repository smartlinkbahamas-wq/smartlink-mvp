const nodemailer = require("nodemailer");

// Built lazily so the API boots with mail unconfigured. Sending then fails
// loudly on the one request that needed it, instead of the whole app refusing
// to start.
let transporter = null;

function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isMailConfigured()) return null;

  const port = Number(process.env.SMTP_PORT || 465);

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

function getFromAddress() {
  const address = process.env.MAIL_FROM || process.env.SMTP_USER;
  const name = process.env.MAIL_FROM_NAME || "SmartLink Bahamas";
  return `"${name}" <${address}>`;
}

// Never throws: a failed send must not take down the request that triggered it
// (a sign-up should still succeed if the welcome mail bounces). Returns a
// result the caller can log or surface.
async function sendMail({ to, subject, html, text }) {
  const mailer = getTransporter();

  if (!mailer) {
    console.warn(`[mail] not configured — skipped "${subject}" to ${to}`);
    return { sent: false, skipped: true, reason: "mail_not_configured" };
  }

  try {
    const info = await mailer.sendMail({
      from: getFromAddress(),
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
    });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[mail] failed to send "${subject}" to ${to}:`, error.message);
    return { sent: false, skipped: false, reason: error.message };
  }
}

// Confirms the SMTP credentials without sending anything. Used by the
// /health/mail check so a misconfiguration is visible before a user hits it.
async function verifyMailConnection() {
  const mailer = getTransporter();
  if (!mailer) return { ok: false, reason: "mail_not_configured" };

  try {
    await mailer.verify();
    return { ok: true, host: process.env.SMTP_HOST, user: process.env.SMTP_USER };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Email clients are not browsers: tables for structure, inline styles only,
// no flexbox or external CSS. Outlook in particular ignores everything else.
const BRAND = {
  navy: "#101B33",
  blue: "#2E67E8",
  ink: "#1F2937",
  muted: "#6B7A94",
  line: "#E4EBF7",
  wash: "#F5F8FD",
};

function layout({ preheader, heading, bodyHtml, footerNote }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.wash};">
  <!-- Shown as the inbox snippet, then hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.wash};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 2px 14px rgba(21,37,64,0.07);">

          <tr>
            <td style="background:${BRAND.navy};padding:22px 28px;">
              <span style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.2px;">
                SmartLink<span style="color:#49B6E8;">Bahamas</span>
              </span>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 28px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-size:21px;line-height:28px;font-weight:700;color:${BRAND.navy};">${heading}</h1>
              ${bodyHtml}
            </td>
          </tr>

          <tr>
            <td style="padding:0 28px;">
              <div style="height:1px;background:${BRAND.line};"></div>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:12px;line-height:19px;color:${BRAND.muted};">
                ${footerNote}
              </p>
            </td>
          </tr>

        </table>

        <p style="margin:18px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9AA7BD;">
          &copy; ${new Date().getFullYear()} SmartLink Bahamas &middot; Nassau, The Bahamas
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendOtpEmail({ to, code, expiresMinutes }) {
  const digits = String(code)
    .split("")
    .map(
      (d) => `<td align="center" style="padding:0 3px;">
        <div style="width:44px;height:54px;line-height:54px;background:${BRAND.wash};border:1px solid ${BRAND.line};border-radius:10px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:24px;font-weight:700;color:${BRAND.navy};">${d}</div>
      </td>`,
    )
    .join("");

  return sendMail({
    to,
    subject: `${code} is your SmartLink Bahamas sign-in code`,
    text: `Your sign-in code is ${code}. It expires in ${expiresMinutes} minutes. If you did not try to sign in, ignore this email.`,
    html: layout({
      preheader: `Your sign-in code is ${code} — expires in ${expiresMinutes} minutes.`,
      heading: "Your sign-in code",
      bodyHtml: `
        <p style="margin:0 0 22px;font-size:15px;line-height:23px;color:${BRAND.ink};">
          Enter this code to finish signing in. It expires in <strong>${expiresMinutes} minutes</strong>.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
          <tr>${digits}</tr>
        </table>
        <p style="margin:0;font-size:13px;line-height:20px;color:${BRAND.muted};">
          Never share this code. SmartLink Bahamas will never ask you for it.
        </p>`,
      footerNote:
        "If you did not try to sign in, you can safely ignore this email and your account stays protected.",
    }),
  });
}

async function sendVerificationEmail({ to, actionLink }) {
  return sendMail({
    to,
    subject: "Confirm your SmartLink Bahamas account",
    text: `Confirm your email address to activate your account: ${actionLink}`,
    html: layout({
      preheader: "One tap to activate your SmartLink Bahamas account.",
      heading: "Confirm your email",
      bodyHtml: `
        <p style="margin:0 0 24px;font-size:15px;line-height:23px;color:${BRAND.ink};">
          You're one step away. Confirm your email address to activate your account and get matched with the right expert.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td style="border-radius:12px;background:${BRAND.blue};">
              <a href="${actionLink}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">
                Confirm my email
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 6px;font-size:12px;color:${BRAND.muted};">Or paste this link into your browser:</p>
        <p style="margin:0;font-size:12px;line-height:18px;word-break:break-all;">
          <a href="${actionLink}" style="color:${BRAND.blue};text-decoration:none;">${actionLink}</a>
        </p>`,
      footerNote:
        "This link expires for your security. If you did not create a SmartLink Bahamas account, you can ignore this email.",
    }),
  });
}

module.exports = {
  isMailConfigured,
  sendMail,
  verifyMailConnection,
  sendOtpEmail,
  sendVerificationEmail,
};
