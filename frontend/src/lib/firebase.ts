import { getApp, getApps, initializeApp } from "firebase/app";
import { FacebookAuthProvider, GoogleAuthProvider, getAuth, signInWithPopup } from "firebase/auth";

// These values are public by design: they ship in the browser bundle and
// identify the project, they do not authorise anything on their own.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}

function getFirebaseApp() {
  if (!isFirebaseConfigured()) {
    throw new Error("Google sign-in is not configured.");
  }
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

// Opens the Google chooser and returns the ID token for the backend to verify.
// The token is the only thing that leaves this function: the backend decides
// who the user is, never the browser.
export async function signInWithGoogleGetIdToken(): Promise<string> {
  const auth = getAuth(getFirebaseApp());
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const credential = await signInWithPopup(auth, provider);
  return credential.user.getIdToken();
}

export async function signInWithFacebookGetIdToken(): Promise<string> {
  const auth = getAuth(getFirebaseApp());
  const provider = new FacebookAuthProvider();
  provider.addScope("email");

  const credential = await signInWithPopup(auth, provider);
  return credential.user.getIdToken();
}

// A popup the person dismissed is not an error worth showing them.
export function isDismissedPopupError(error: unknown) {
  const code = (error as { code?: string })?.code || "";
  return (
    code === "auth/popup-closed-by-user" ||
    code === "auth/cancelled-popup-request" ||
    code === "auth/user-cancelled"
  );
}
