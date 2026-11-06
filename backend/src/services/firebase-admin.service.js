const fs = require("fs");
const admin = require("firebase-admin");

const { AppError } = require("../utils/app-error");

// Initialised lazily so the API still boots when Firebase is not configured
// yet. Only the Google sign-in route fails in that case, not the whole app.
let app = null;
let initError = null;

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch (error) {
      throw new AppError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.", 500, error.message);
    }
  }

  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path) return null;

  if (!fs.existsSync(path)) {
    throw new AppError(`Firebase service account file not found at ${path}.`, 500);
  }

  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new AppError("Firebase service account file is not valid JSON.", 500, error.message);
  }
}

function getFirebaseApp() {
  if (app) return app;
  if (initError) throw initError;

  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
      throw new AppError(
        "Google sign-in is not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH on the server.",
        503,
        { code: "firebase_not_configured" },
      );
    }

    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    return app;
  } catch (error) {
    initError = error instanceof AppError ? error : new AppError("Failed to initialise Firebase.", 500, error.message);
    throw initError;
  }
}

function isFirebaseConfigured() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

// Verifies the ID token the browser obtained from Google via Firebase and
// returns only the claims we trust for sign-in. checkRevoked makes a revoked
// session fail here rather than silently minting an app session.
async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw new AppError("A Firebase ID token is required.", 400, { code: "firebase_token_missing" });
  }

  const firebaseApp = getFirebaseApp();

  let decoded;
  try {
    decoded = await firebaseApp.auth().verifyIdToken(idToken, true);
  } catch (error) {
    throw new AppError("Google sign-in could not be verified. Please try again.", 401, {
      code: "firebase_token_invalid",
      raw: error.message,
    });
  }

  const email = decoded.email;
  if (!email) {
    throw new AppError("That Google account has no email address attached.", 400, {
      code: "firebase_email_missing",
    });
  }

  // Google asserts this; refusing unverified addresses stops someone claiming
  // an email they do not control and inheriting an existing account.
  if (decoded.email_verified === false) {
    throw new AppError("Your Google email address is not verified.", 403, {
      code: "firebase_email_unverified",
    });
  }

  return {
    uid: decoded.uid,
    email,
    fullName: decoded.name || null,
    picture: decoded.picture || null,
    provider: decoded.firebase?.sign_in_provider || "google.com",
  };
}

module.exports = {
  isFirebaseConfigured,
  verifyFirebaseIdToken,
};
