// Shared port constants for the e2e run, so playwright.config.js (which
// starts both servers) and the specs (which sometimes need to talk to the
// backend directly, e.g. to reset global connectivity state before a
// journey) never drift out of sync.
export const BACKEND_PORT = 4410;
export const FRONTEND_PORT = 5273;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}/api`;

// A second backend + frontend pair with AUTH_MODE=local, for the sign-in
// and role-based-access journeys (e2e/auth.spec.js).
export const AUTH_BACKEND_PORT = 4411;
export const AUTH_FRONTEND_PORT = 5274;
export const AUTH_BACKEND_URL = `http://127.0.0.1:${AUTH_BACKEND_PORT}/api`;
export const AUTH_FRONTEND_URL = `http://127.0.0.1:${AUTH_FRONTEND_PORT}`;
