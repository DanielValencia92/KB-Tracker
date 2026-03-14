/**
 * auth.ts — KB Tracker sign-in page
 *
 * Uses chrome.identity.launchWebAuthFlow instead of signInWithPopup to avoid
 * MV3's strict CSP which blocks the remote script that signInWithPopup injects
 * from apis.google.com.
 *
 * Flow:
 *  1. User clicks "Sign in with Google"
 *  2. chrome.identity.launchWebAuthFlow opens a native sandboxed Chrome popup
 *  3. Extract the access_token from the redirected URL hash
 *  4. signInWithCredential(auth, GoogleAuthProvider.credential(null, accessToken))
 *  5. Store AuthState in browser.storage.local, notify service worker, close tab
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
} from 'firebase/auth';
import browser from 'webextension-polyfill';
import { firebaseConfig, oauthClientId } from '../firebase/config';
import type { AuthState, ExtMessage } from '../shared/types';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const signinBtn = document.getElementById('signin-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = kind === 'info' ? '' : kind;
}

// chrome.identity is Chrome-only; show a clear message on Firefox
if (!chrome.identity?.launchWebAuthFlow) {
  signinBtn.disabled = true;
  setStatus('Cloud sync requires Chrome. Firefox is not supported yet.', 'error');
}

signinBtn.addEventListener('click', async () => {
  if (!chrome.identity?.launchWebAuthFlow) return;
  signinBtn.disabled = true;
  setStatus('Opening Google sign-in…');

  try {
    // Build the Google OAuth URL — response_type=token returns an access_token
    // in the hash fragment which Chrome intercepts via the chromiumapp.org redirect.
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
    authUrl.searchParams.set('client_id', oauthClientId);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('scope', 'email profile openid');
    authUrl.searchParams.set('prompt', 'select_account');

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.href,
      interactive: true,
    });

    if (!responseUrl) throw new Error('Auth flow returned no URL');

    const hashParams = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    const accessToken = hashParams.get('access_token');
    if (!accessToken) throw new Error('No access_token in auth response');

    // Sign in to Firebase using the Google access token (no remote scripts needed)
    const tokenResult = await chrome.identity.getAuthToken({ interactive: true });
    const credential = GoogleAuthProvider.credential(null, tokenResult.token);
    const result = await signInWithCredential(auth, credential);
    const user = result.user;

    const idTokenResult = await user.getIdTokenResult(/* forceRefresh */ false);
    const expiry = new Date(idTokenResult.expirationTime).getTime();

    // @ts-expect-error – stsTokenManager is an internal Firebase field
    const refreshToken: string = (user as unknown as { stsTokenManager: { refreshToken: string } })
      .stsTokenManager.refreshToken;

    const authState: AuthState = {
      uid: user.uid,
      email: user.email ?? '',
      displayName: user.displayName ?? '',
      photoURL: user.photoURL ?? '',
      idToken: idTokenResult.token,
      idTokenExpiry: expiry,
      refreshToken,
    };

    await browser.storage.local.set({ kb_auth: authState });

    // Notify the service worker so it can wire up sync
    await browser.runtime.sendMessage({ type: 'AUTH_SIGNED_IN', payload: authState } as ExtMessage);

    setStatus('Signed in! You can close this tab.', 'success');
    signinBtn.textContent = '✓ Signed in';

    // Close the tab after a short delay so the user can read the message
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    console.error('[KB Tracker] sign-in error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Sign-in failed: ${msg}`, 'error');
    signinBtn.disabled = false;
  }
});

