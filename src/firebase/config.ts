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
export const oauthClientId = '943581460966-6vmgf2jqd22phsa178hon8ue7rvnl44a.apps.googleusercontent.com';

export const firebaseConfig = {
  apiKey: "AIzaSyCVGI-76CIFnBBLvVz-zdZMa9fS-lHDe6c",
  authDomain: "kb-tracker-2e703.firebaseapp.com",
  projectId: "kb-tracker-2e703",
  storageBucket: "kb-tracker-2e703.firebasestorage.app",
  messagingSenderId: "943581460966",
  appId: "1:943581460966:web:295f0ec6af6771bfef3e27"
};
