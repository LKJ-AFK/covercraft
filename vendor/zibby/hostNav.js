// Leaving the app, from inside the iframe — the app's half of the navigation,
// lifted out of the five first-party apps unchanged (M4-WP2, 2026-09-17).
//
// The bundle is served from its own origin in production —
// `https://a<id>.zibby.run` since 2026-08-27 — so an app-authored
// `href="/runs"` with `target="_top"` resolves against THAT origin and 404s.
// The kit says so itself, on `ZIBBY_CREDITS_PATH`: "on a per-app origin this
// resolves against that origin and the platform 404s it".
//
// The MESSAGE is `navigateHost`'s, one file over in `hostBridge.ts`, and
// nothing here writes one. That matters for exactly one reason: the target
// origin. The bridge posts only to the shell origin a trusted inbound message
// has already arrived from; before one has, it falls back to the top window at
// an allow-listed parent origin. A file that guessed — `document.referrer`,
// then `"*"` — would broadcast the one outbound message that names where a
// person is being sent.
//
// What lives here is the app's own half:
//
//   1. THE ALLOW-LIST. The bridge refuses anything that is not a same-site
//      absolute path, and the shell keeps its own list; an app links to six
//      places, and a function that will carry an arbitrary path is a redirect
//      primitive handed to whatever ends up calling it. Three lists is not
//      duplication, it is the guard holding at each end.
//   2. WHERE THE LINK POINTS when there is no shell to ask (`fallbackHref`).
import { navigateHost } from "./hostBridge.js";
/** Every shell destination an app is allowed to ask for, and the section name
 *  shown when there is no shell to ask. The same six paths the five apps each
 *  listed; a seventh is a route to be added to the platform, the shell and
 *  this map together — not a line to work around at the call site. */
const SHELL_PATHS = {
    "/": "Home",
    "/runs": "Runs",
    "/billing": "Billing",
    "/credits": "Credits",
    "/users/log-in": "Sign in",
    "/users/settings": "Settings",
};
/** The shell host ROOT — no path, because a path is exactly what a per-app
 *  origin cannot resolve. Only ever used where `fallbackHref` says so. */
export const SHELL_HOST_ROOT = "https://zibby.run";
/** The per-app origin, `a<id>.zibby.run`: the one place a relative shell path
 *  is guaranteed to 404, because nothing but the bundle is served there. */
const PER_APP_HOST = /^a[0-9a-f-]+\./;
export const isShellPath = (path) => Object.prototype.hasOwnProperty.call(SHELL_PATHS, path);
export const shellPathLabel = (path) => SHELL_PATHS[path] ?? "Home";
export const isEmbedded = () => typeof window !== "undefined" && !!window.parent && window.parent !== window;
/** Where the standalone anchor points.
 *
 *  On a per-app origin, the shell root — nothing else on that host exists.
 *  ANYWHERE ELSE the path itself, relative: on the same-origin lane
 *  (`zibby.run/apps/<id>/`) `/credits` IS the credits page, and on a dev
 *  server or a preview host a hard-coded `https://zibby.run` would walk the
 *  user off the deployment they are looking at. */
export const fallbackHref = (path) => typeof window !== "undefined" && PER_APP_HOST.test(window.location.hostname)
    ? SHELL_HOST_ROOT
    : path;
/** Ask the shell to navigate. Returns whether this app's allow-list accepted
 *  the request — a false means the path is not one the app routes and the
 *  caller is on its own. A true is not a promise that the shell moved: the
 *  bridge either posts to the learned shell origin, or navigates the top
 *  window at an allow-listed parent origin, and a shell that does not listen
 *  ignores it. */
export const hostNavigate = (path) => {
    if (!isShellPath(path))
        return false;
    navigateHost(path);
    return true;
};
