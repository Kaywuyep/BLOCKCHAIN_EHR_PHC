import { createContext, useContext } from 'react';
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * auth.js
 *
 * The frontend side of the backend's AUTH_MODE:
 *   off    no login; the demo behaves as before.
 *   local  a development login form (POST /api/auth/login).
 *   oidc   authorization code + PKCE against the hospital's identity
 *          provider, using oidc-client-ts.
 *
 * The access token is kept in sessionStorage: it is gone when the tab
 * closes, and is never written to localStorage.
 */

const BASE = import.meta.env.VITE_API_BASE || '/api';
const TOKEN_KEY = 'patientchain.token';

let userManager = null;

export const SessionContext = createContext({ session: null, authMode: 'off', refresh: async () => {}, logout: () => {} });
export const useSession = () => useContext(SessionContext);

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the session lasts until reload
  }
}

export async function fetchAuthConfig() {
  const res = await fetch(`${BASE}/auth/config`);
  if (!res.ok) throw new Error('backend unreachable');
  return res.json();
}

function oidcManager(oidc) {
  if (!userManager) {
    userManager = new UserManager({
      authority: oidc.issuer,
      client_id: oidc.clientId,
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: window.location.origin,
      response_type: 'code',
      scope: 'openid profile',
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: true,
    });
    userManager.events.addUserLoaded((user) => setToken(user.access_token));
  }
  return userManager;
}

/** Completes an OIDC redirect if this page load is one. */
export async function completeOidcRedirect(config) {
  if (config.mode !== 'oidc' || window.location.pathname !== '/auth/callback') return false;
  const user = await oidcManager(config.oidc).signinRedirectCallback();
  setToken(user.access_token);
  window.history.replaceState({}, '', '/');
  return true;
}

export async function startOidcLogin(config) {
  await oidcManager(config.oidc).signinRedirect();
}

export async function localLogin({ subject, role, hospitalID, providerID }) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, role, hospitalID: hospitalID || undefined, providerID: providerID || undefined }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'login failed');
  setToken(body.token);
}

/** The signed-in identity as the backend sees it, or null. */
export async function fetchSession() {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    setToken(null);
    return null;
  }
  if (!res.ok) throw new Error('could not load session');
  return res.json();
}

export async function logout(config) {
  setToken(null);
  if (config?.mode === 'oidc' && userManager) {
    await userManager.signoutRedirect().catch(() => window.location.assign('/'));
    return;
  }
  window.location.assign('/');
}

/** Which pages a role may open. */
export const TABS_FOR_ROLE = {
  patient: ['/patient'],
  clinician: ['/clinician'],
  hospital_admin: ['/admin'],
  system_admin: ['/patient', '/clinician', '/admin'],
  hl7_interface: [],
};

export function allowedTabs(session) {
  if (!session || session.superuser) return ['/patient', '/clinician', '/admin'];
  return [...new Set(session.roles.flatMap((r) => TABS_FOR_ROLE[r] || []))];
}
