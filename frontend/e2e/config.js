// Shared port constants for the e2e run, so playwright.config.js (which
// starts both servers) and the specs (which sometimes need to talk to the
// backend directly, e.g. to reset global connectivity state before a
// journey) never drift out of sync.
export const BACKEND_PORT = 4410;
export const FRONTEND_PORT = 5273;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}/api`;
