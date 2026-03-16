/**
 * Firebase project configuration.
 *
 * Fill in the values from your Firebase console
 * (Project Settings → Your apps → Web app → SDK setup and configuration).
 *
 * This file is intentionally NOT committed to the public repository.
 * Copy firebase.config.example.ts → firebase/config.ts and fill in your values.
 */

/**
 * Google OAuth 2.0 Web Client ID for chrome.identity sign-in.
 * Find this in: Firebase Console → Authentication → Sign-in method
 *   → Google → expand → Web client ID
 * Also add chrome.identity.getRedirectURL() as an authorized redirect URI
 * in Google Cloud Console → APIs & Services → Credentials → that OAuth client.
 */
export const oauthClientId = import.meta.env.VITE_OAUTH_CLIENT_ID as string;

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
};
