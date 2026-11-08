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

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3ebf7;border-radius:16px;padding:28px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#152540;">${title}</h1>
      ${bodyHtml}
      <p style="margin:28px 0 0;font-size:12px;color:#8894ac;">
        SmartLink Bahamas &middot; If you did not expect this email you can ignore it.
      </p>
    </div>
  </body>
</html>`;
}

async function sendOtpEmail({ to, code, expiresMinutes }) {
  return sendMail({
    to,
    subject: `${code} is your SmartLink Bahamas verification code`,
    text: `Your verification code is ${code}. It expires in ${expiresMinutes} minutes.`,
    html: layout(
      "Your verification code",
      `<p style="margin:0 0 20px;font-size:14px;line-height:22px;">Enter this code to finish signing in.</p>
       <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;color:#2E67E8;">${code}</p>
       <p style="margin:0;font-size:13px;color:#5c6f8d;">This code expires in ${expiresMinutes} minutes.</p>`,
    ),
  });
}

async function sendVerificationEmail({ to, actionLink }) {
  return sendMail({
    to,
    subject: "Confirm your SmartLink Bahamas account",
    text: `Confirm your email address: ${actionLink}`,
    html: layout(
      "Confirm your email",
      `<p style="margin:0 0 20px;font-size:14px;line-height:22px;">Tap the button below to confirm your email address and activate your account.</p>
       <p style="margin:0 0 24px;">
         <a href="${actionLink}" style="display:inline-block;background:#2E67E8;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:12px;font-size:14px;font-weight:600;">Confirm email</a>
       </p>
       <p style="margin:0;font-size:12px;color:#8894ac;word-break:break-all;">Or paste this link into your browser:<br>${actionLink}</p>`,
    ),
  });
}

module.exports = {
  isMailConfigured,
  sendMail,
  verifyMailConnection,
  sendOtpEmail,
  sendVerificationEmail,
};
