// The channel between the Zibby shell and an embedded app — across origins
// since 2026-08-27, when bundles moved onto per-app hosts (`a<id>.zibby.run`)
// and the same-origin shortcuts stopped existing.
//
// The token for `/api/ai` arrives one of two ways:
//
//   * a meta tag in the app's OWN document —
//     `<meta name="zibby-csrf-token">` (alias `csrf-token`) — which only a
//     same-origin shell can inject. Where present it wins, unchanged.
//   * a postMessage from the parent page:
//     `{ type: "zibby:csrf", token }`. Signed-out shells send `token: null`;
//     that still identifies their trusted origin without authenticating API
//     calls. On a per-app origin this is the ONLY way: the document is served
//     byte-for-byte off disk and cross-origin JavaScript cannot read anything
//     of the parent's.
//
// The app announces itself on mount with `{ type: "zibby:hello" }` and the
// shell answers with its token or null; when signed in it also re-pushes a
// fresh token on an interval, so the cached copy here never outlives its
// ten-minute life. When a request still comes back 401 — a laptop asleep past
// every refresh, or a LiveView socket that dropped and took the interval with
// it — `requestFreshToken()` says hello ONCE more, this time carrying
// `refresh: true`.
//
// That field is the whole fix (2026-09-12, QA ZIBBY-31). A shell answering a
// PLAIN hello posts the token it has cached; it does not mint. So the re-ask
// used to come back holding the very token that had just been refused, the
// retry was skipped, and the person saw an error until the next four-minute
// tick or a page refresh healed it. `refresh: true` asks the shell to mint
// before it answers. Shells too old to know the field ignore it and answer as
// they always did — today's dead end, no regression.
//
// The wait ends only on a token that DIFFERS from the one that failed, on
// `null` (the shell saying nobody is signed in), or on its timeout;
// `client.ts` retries once with what arrives.
//
// The shell's answer may additively carry platform figures alongside the
// token: `avg_action_cr` for the app-wide average and optional
// `avg_action_cr_by_action` for each action's recent eligible runs.
//
// TRUST: inbound messages are accepted from the app's own origin (the
// same-origin deployments, dev included) and from the Zibby shell origins
// baked in at build time — nothing else. `zibby:hello` goes out with target
// `"*"`, which is fine precisely because it carries nothing; anything
// carrying a token is only ever RECEIVED here, never sent.
//
// NAVIGATION (additive, 2026-09-02). `navigateHost("/billing")` asks the shell
// to take the person to a Zibby page. It exists because the obvious thing does
// not work: on a per-app origin an `href="/billing"` with `target="_top"`
// resolves against `a42.zibby.run`, where no such page lives, and 404s. The
// shell is the window that is actually on `zibby.run`, so it does the
// navigating.
//
// This message carries a destination, so unlike `hello` it may never target
// `"*"`. It is posted to the shell origin the bridge has already learned from
// a trusted inbound message. Until one has arrived, an allow-listed path
// navigates the top window at the known allow-listed parent origin (or the first
// configured origin), so a signed-out click cannot disappear. An app that is not embedded at all also
// navigates its own top window, the same `target="_top"` the contract always
// described.
//
// IDENTITY (additive, 2026-09-18). The token answer may also carry
// `app_user_id` — this app's own stable name for the signed-in person, sent
// only when the token is non-null AND the app's "Stores user data" switch is
// on. It is cached and published by `appUser.ts` exactly as the balance is by
// `balance.ts`, it is never persisted and never sent anywhere, and an answer
// that stops carrying it WITHDRAWS it: a stale id is the last person's.
//
// COMPED (additive, kit 0.7.0). The token answer may also carry
// `comped: true` — this person's runs are on Zibby (an admin, or an account an
// admin comped), so the app shows no price and no charge. It is read only
// from `window.parent`, as the picker's answers and the job push are, and only
// the JSON `true` counts; an answer without it withdraws it (`comped.ts`).
import { ZIBBY_CSRF_META_NAMES } from "./config.js";
import { publishBalance, ZIBBY_BALANCE_EVENT } from "./balance.js";
import { publishAppUserId } from "./appUser.js";
import { publishComped } from "./comped.js";
export const ZIBBY_CSRF_MESSAGE = "zibby:csrf";
export const ZIBBY_HELLO_MESSAGE = "zibby:hello";
export const ZIBBY_NAVIGATE_MESSAGE = "zibby:navigate";
export const ZIBBY_TRACK_MESSAGE = "zibby:track";
export const ZIBBY_ERROR_MESSAGE = "zibby:error";
/** In-page CustomEvent dispatched when the shell's answer carries a fresh
 *  quote. Detail carries avg_action_cr and optional avg_action_cr_by_action.
 *  Mirrors the `zibby:balance` pattern. */
export const ZIBBY_QUOTE_EVENT = "zibby:quote";
/** The shell origins allowed to hand this app a token. Baked at BUILD time —
 *  a new shell origin (a staging domain, say) needs a rebuild+republish, not
 *  a server change. Overridable two ways, install option winning:
 *  `installHostBridge({ parentOrigins })`, else the comma-separated
 *  `NEXT_PUBLIC_ZIBBY_PARENT_ORIGINS` env (inlined by the consumer's
 *  bundler), else the real site plus the dev shell. */
const DEFAULT_PARENT_ORIGINS = "https://zibby.run,https://www.zibby.run,http://localhost:4000";
const envParentOrigins = () => {
    try {
        if (typeof process === "undefined")
            return DEFAULT_PARENT_ORIGINS;
        return process.env?.NEXT_PUBLIC_ZIBBY_PARENT_ORIGINS ?? DEFAULT_PARENT_ORIGINS;
    }
    catch {
        return DEFAULT_PARENT_ORIGINS;
    }
};
const parseOrigins = (raw) => raw
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
let parentOrigins = parseOrigins(envParentOrigins());
let receivedToken = null;
// The shell origin a trusted message has actually arrived FROM — learned, not
// guessed. `parentOrigins` is a list of who is allowed to talk to us; this is
// which of them did, and it is the only value `navigateHost` will post to.
let shellOrigin = null;
const pendingTracks = [];
const warnTrack = (reason) => {
    try {
        console.warn(`zibby: track dropped — ${reason}`);
    }
    catch { /* Logging is best effort too. */ }
};
const postTelemetry = (message) => {
    try {
        if (typeof window !== "undefined" && shellOrigin) {
            window.parent.postMessage(message, shellOrigin);
        }
    }
    catch {
        // Analytics and error reporting must never break the app or report themselves.
    }
};
/** Record an app event. Never put personal data in props. Invalid events are
 *  warned and dropped; the first 50 valid events wait for the shell handshake. */
export const track = (name, props = {}) => {
    try {
        if (typeof name !== "string" || name.length < 1 || name.length > 64 || /[^a-z0-9_.:-]/.test(name)) {
            warnTrack("name must match /^[a-z0-9_.:-]{1,64}$/");
            return;
        }
        if (!props || typeof props !== "object" ||
            (Object.getPrototypeOf(props) !== Object.prototype && Object.getPrototypeOf(props) !== null)) {
            warnTrack("props must be a flat object");
            return;
        }
        // Copy at call time so later mutation cannot change a queued event or bypass
        // validation. A null prototype also preserves an own '__proto__' key safely.
        const snapshot = Object.create(null);
        for (const [key, value] of Object.entries(props)) {
            if (typeof value !== "string" && typeof value !== "boolean" &&
                !(typeof value === "number" && Number.isFinite(value))) {
                warnTrack("props values must be strings, finite numbers, or booleans");
                return;
            }
            snapshot[key] = value;
        }
        const json = JSON.stringify(snapshot);
        if (new TextEncoder().encode(json).byteLength > 2048) {
            warnTrack("props JSON exceeds 2048 bytes");
            return;
        }
        if (typeof window === "undefined")
            return;
        const message = { type: ZIBBY_TRACK_MESSAGE, name, props: JSON.parse(json) };
        if (shellOrigin)
            postTelemetry(message);
        else if (pendingTracks.length < 50)
            pendingTracks.push(message);
        else
            warnTrack("pre-handshake queue is full (50 events)");
    }
    catch {
        warnTrack("props could not be read or serialized");
    }
};
// Shared across installs and both sources: mounting a second bridge must not
// double-report an exception or reset its rolling one-minute budget.
let errorListenerUsers = 0;
let errorTimes = [];
const capStack = (stack) => {
    let bytes = 0;
    let result = "";
    const encoder = new TextEncoder();
    for (const char of stack) {
        bytes += encoder.encode(char).byteLength;
        if (bytes > 4096)
            break;
        result += char;
    }
    return result;
};
const forwardError = (source, event) => {
    try {
        if (!shellOrigin)
            return;
        const now = Date.now();
        errorTimes = errorTimes.filter(time => now - time < 60000);
        if (errorTimes.length >= 10)
            return;
        const reason = source === "window" ? event.error : event.reason;
        const message = source === "window"
            ? event.message || reason?.message || "Unknown window error"
            : reason?.message ?? String(reason);
        const stack = typeof reason?.stack === "string" ? reason.stack : "";
        errorTimes.push(now);
        postTelemetry({ type: ZIBBY_ERROR_MESSAGE, message: String(message).slice(0, 500), stack: capStack(stack), source });
    }
    catch {
        // Rejections can contain arbitrary objects, including throwing getters.
    }
};
const onWindowError = (event) => forwardError("window", event);
const onUnhandledRejection = (event) => forwardError("promise", event);
// Counts handshake DELIVERIES. It is how the 401 path tells "the shell
// answered" apart from "the shell said nothing at all": `receivedToken` alone
// cannot, because a signed-out answer and a bridge that has never been
// answered both read as `null`. A delivery is not by itself the end of a
// wait — one carrying the token that just failed is the bug this counter used
// to hide. `requestFreshToken` reads the count and the token together.
let tokenReceipts = 0;
// The platform's live average charge per action for this app, when the shell
// sent one. Null until the first answer that carries it.
let avgActionCr = null;
let avgActionCrByAction;
const trustedOrigin = (origin) => origin === window.location.origin || parentOrigins.includes(origin);
const embedded = () => typeof window !== "undefined" && !!window.parent && window.parent !== window;
/** Did this message come from the parent window? Not embedded, the parent IS
 *  this window, which is what the dev mock bridge posts from. A `source` that
 *  cannot be compared is not the parent. */
const fromParent = (event) => {
    try {
        return !!event.source && event.source === window.parent;
    }
    catch {
        return false;
    }
};
const metaToken = () => {
    if (typeof document === "undefined")
        return null;
    for (const name of ZIBBY_CSRF_META_NAMES) {
        const token = document.querySelector(`meta[name="${name}"]`)?.content?.trim();
        if (token)
            return token;
    }
    return null;
};
/** The token for `/api/ai`: the app's own meta tag first, then whatever the
 *  shell posted in. Null means the request goes out without the header and the
 *  proxy will (correctly) refuse it. */
export const readCsrfToken = () => metaToken() ?? receivedToken;
/** The named action's shell-reported average, falling back to the app-wide
 *  figure. Without an action, reads the app-wide average. Null without data. */
export const readAvgActionCr = (action) => action !== undefined && avgActionCrByAction && Object.prototype.hasOwnProperty.call(avgActionCrByAction, action)
    ? avgActionCrByAction[action]
    : avgActionCr;
/** `refresh: true` asks a shell that understands it to MINT a token before
 *  answering, instead of repeating the cached one. Sent on the 401 path only:
 *  the mount announce wants whatever the shell already holds. */
const sayHello = (refresh = false) => {
    if (!embedded())
        return;
    try {
        // Target "*" is deliberate and safe: hello carries nothing but a request
        // to be answered. Naming the parent's origin here is impossible anyway —
        // a cross-origin iframe cannot read it, and guessing wrong would make the
        // browser drop the announce silently, which is exactly the bug this
        // design removes.
        window.parent.postMessage(refresh ? { type: ZIBBY_HELLO_MESSAGE, refresh: true } : { type: ZIBBY_HELLO_MESSAGE }, "*");
    }
    catch {
        // A parent that refuses to hear us is none of our business.
    }
};
/** Has the shell answered the re-ask with something worth retrying?
 *
 *  A delivery of `staleToken` is the shell repeating what just failed — an old
 *  shell that ignored `refresh`, or a new one whose LiveView is still down.
 *  Treating that as the answer is the whole of QA ZIBBY-31, so it is not one:
 *  the wait carries on. `null` IS an answer — the shell saying nobody is
 *  signed in — and ends the wait immediately so a signed-out 401 surfaces at
 *  once instead of after eight seconds of hoping. */
const freshTokenArrived = (staleToken, receiptsBefore) => {
    if (tokenReceipts === receiptsBefore)
        return false;
    const current = readCsrfToken();
    return current === null || current !== staleToken;
};
/** Resolves true when an answer arrived, false when `timeoutMs` ran out. */
const waitForFreshToken = (staleToken, receiptsBefore, timeoutMs) => new Promise(resolve => {
    const startedAt = Date.now();
    const poll = () => {
        if (freshTokenArrived(staleToken, receiptsBefore))
            return resolve(true);
        if (Date.now() - startedAt >= timeoutMs)
            return resolve(false);
        setTimeout(poll, 100);
    };
    poll();
});
/**
 * Say hello once more — with `refresh: true`, so a shell that understands it
 * mints — and wait for an answer that is not the token that just failed. The
 * 401 path, and the only caller of it is a request that got one.
 *
 * Resolves with the freshest token available. That may still be the old one
 * (an old shell, or a shell whose socket never came back), and the caller
 * decides whether what it holds is worth a retry: `client.ts` and `fetch.ts`
 * both retry only on a token that changed.
 *
 * The second wait exists because the shell's LiveView reconnects on its own
 * schedule after a laptop wakes; three seconds is often the reconnect and not
 * the answer. Eight seconds total is the ceiling on a path that only runs
 * after a request has already been refused.
 *
 * `staleToken` — the token the failed request used — is what the wait refuses
 * to accept back. Name it where you have it; the kit's own callers do. Called
 * without it, the bridge takes its own token as the stale one, snapshotted
 * BEFORE the hello goes out, so an echo of what it was already holding cannot
 * end the wait the instant it lands. Pass `null` explicitly to say the failed
 * request carried NO token, where any token at all is an improvement.
 *
 * ADDITIVE, and the old call form still means what it did: this used to be
 * `requestFreshToken(timeoutMs = 3000)`, so a number in the first slot is read
 * as the first wait, exactly as before. The two timeouts are arguments only so
 * the tests need not spend eight real seconds proving the ceiling — no app
 * passes them, and there is no knob for one to set.
 */
export const requestFreshToken = async (staleTokenOrTimeoutMs, timeoutMs = 3000, secondTimeoutMs = 5000) => {
    if (!embedded())
        return readCsrfToken();
    // The legacy one-argument form, kept working rather than kept around: a
    // number was always the wait, never a token.
    const legacyTimeout = typeof staleTokenOrTimeoutMs === "number";
    const firstWaitMs = legacyTimeout ? staleTokenOrTimeoutMs : timeoutMs;
    // Snapshotted before the hello, so that a caller who named no token still
    // gets the "not the one I already have" rule rather than "the first thing
    // that arrives" — which is the bug, one call site further out.
    const staleToken = typeof staleTokenOrTimeoutMs === "string" || staleTokenOrTimeoutMs === null
        ? staleTokenOrTimeoutMs
        : readCsrfToken();
    const receiptsBefore = tokenReceipts;
    sayHello(true);
    // Same-origin embedding: the token is the app's own meta tag, which wins
    // over anything posted in and which no message can replace. A deliberate
    // fast path — waiting would be eight seconds spent on an answer that cannot
    // change the outcome, so the 401 surfaces immediately instead.
    const meta = metaToken();
    if (meta)
        return meta;
    if (!(await waitForFreshToken(staleToken, receiptsBefore, firstWaitMs))) {
        await waitForFreshToken(staleToken, receiptsBefore, secondTimeoutMs);
    }
    return readCsrfToken();
};
/** A dot segment is how a path becomes a DIFFERENT path: `/@a/../../admin`
 *  reads as an app page and is `/admin` by the time a browser has resolved
 *  it. `%2e` is the same segment spelled to slip a check that looks only for
 *  a literal dot — a URL parser decodes it before it collapses dot segments —
 *  so both spellings are refused, in either case. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
/** A path this app may ask the shell to go to: same-site, absolute, and
 *  naming the place it actually resolves to.
 *  `//host` and `/\host` are protocol-relative URLs in a browser's parser,
 *  not paths, and are refused with everything else that names an origin.
 *  Dot segments and empty ones (`/@a//admin`) are refused for the same
 *  reason: the shell's allow-list is matched against the NORMALISED path, so
 *  a path that changes on the way there is one the two ends would disagree
 *  about. `"/"` — the Zibby home page — is a path and is allowed. */
export const sameSitePath = (path) => {
    if (typeof path !== "string")
        return false;
    if (!path.startsWith("/"))
        return false;
    if (path.startsWith("//") || path.startsWith("/\\"))
        return false;
    // The leading "" is the opening slash, and `"/"` is the one path whose only
    // segment is legitimately empty.
    return path
        .split("/")
        .slice(1)
        .every(segment => (segment !== "" || path === "/") && !DOT_SEGMENT.test(segment));
};
const HOST_PATHS = new Set([
    "/",
    "/runs",
    "/billing",
    "/credits",
    "/users/log-in",
    "/users/settings",
]);
/** Keep this in lockstep with the shell's navigation allow-list. Unlike a
 *  posted message, a fallback navigation has no shell listener left to refuse
 *  an off-list route, so the kit must make the same decision before touching
 *  the top window. */
const hostNavigationPath = (path) => !path.includes("?") &&
    !path.includes("#") &&
    (HOST_PATHS.has(path) || /^\/@[^/?#\\]+\/[^/?#\\]+$/.test(path));
const postNavigate = (path) => {
    if (!shellOrigin)
        return;
    try {
        window.parent.postMessage({ type: ZIBBY_NAVIGATE_MESSAGE, path }, shellOrigin);
    }
    catch {
        // A parent that refuses to hear us is none of our business.
    }
};
/**
 * Ask the Zibby shell to navigate to `path` — `/billing`, `/runs`,
 * `/users/log-in`, an app page.
 *
 * Use it for every link out of the app. A plain `href` with `target="_top"`
 * 404s on a per-app origin (CONTRACT.md §1), and this is the supported way
 * across.
 *
 * `path` must be a same-site absolute path that does not traverse (no `.`,
 * `..`, `%2e` or empty segments), and it must match the shell's host-page
 * allow-list without a query or fragment. Anything else is ignored with a
 * console warning. The shell keeps the same allow-list as a second check.
 *
 * Before the shell has said anything to this app, the path is not queued: the
 * top window navigates immediately to that path at the known allow-listed parent
 * origin, falling back to the first configured origin. Once a trusted answer
 * (including `token: null`) identifies the shell origin, navigation is posted
 * there and never broadcast to `"*"`.
 */
export const navigateHost = (path) => {
    if (!sameSitePath(path)) {
        console.warn(`zibby: navigateHost refused ${String(path)} — same-site paths only`);
        return;
    }
    if (!hostNavigationPath(path)) {
        console.warn(`zibby: navigateHost refused ${path} — host paths only`);
        return;
    }
    if (typeof window === "undefined")
        return;
    if (!embedded()) {
        // Nothing to ask: this window IS the top one. Same-origin, so the path
        // resolves the way `target="_top"` always meant it to.
        try {
            if (window.top)
                window.top.location.href = path;
        }
        catch {
            // A top window we may not touch is not one we can navigate.
        }
        return;
    }
    if (shellOrigin) {
        postNavigate(path);
        return;
    }
    const ancestorOrigin = window.location.ancestorOrigins?.[0];
    let referrerOrigin;
    try {
        if (typeof document !== "undefined" && document.referrer) {
            referrerOrigin = new URL(document.referrer).origin;
        }
    }
    catch {
        // A missing or malformed referrer provides no parent-origin hint.
    }
    const fallbackOrigin = [ancestorOrigin, referrerOrigin].find(origin => origin !== undefined && parentOrigins.includes(origin)) ?? parentOrigins[0];
    if (!fallbackOrigin) {
        console.warn("zibby: navigateHost has no configured shell origin");
        return;
    }
    try {
        if (window.top)
            window.top.location.href = new URL(path, fallbackOrigin).href;
    }
    catch {
        // A parent that refuses top navigation is not one we can navigate.
    }
};
// ---------------------------------------------------------------------------
// Replies from the shell (additive, 0.6.0)
//
// The picker's answer (`zibby:picked`, `zibby:pick_cancelled`) and the job
// push (`zibby:job`) are the first inbound messages whose CONTENT an app acts
// on — a file id it will read, a job it will fetch. The token listener above
// trusts an origin; these trust a WINDOW as well: the message must come from
// `window.parent` AND from the one shell origin that has already answered the
// handshake (`shellOrigin`). Anything else — another frame inside the app, a
// popup, the app's own origin in a same-origin preview talking to itself —
// could otherwise forge a pick. (The harm would be small, since reading a
// file still needs the platform's grant, but the check costs nothing: the
// picker lane's review, N6.)
//
// These three are INTERNAL: `src/files.ts` and `src/transcribeJobs.ts` import
// them, and `src/index.ts` does not re-export them.
// ---------------------------------------------------------------------------
/** The shell origin learned from the handshake, or `null` before one. */
export const learnedShellOrigin = () => shellOrigin;
/** Is this message a reply from the Zibby shell — the parent window, on the
 *  origin that answered `zibby:hello`? */
export const isShellReply = (event) => {
    try {
        return (typeof window !== "undefined" &&
            embedded() &&
            shellOrigin !== null &&
            event.origin === shellOrigin &&
            event.source === window.parent);
    }
    catch {
        return false;
    }
};
/**
 * The shell origin, waiting for the handshake when it has not happened yet.
 *
 * A pick asked for in the first moments after mount can race the shell's
 * answer to `zibby:hello`; rather than refuse it, this says hello again and
 * waits up to `timeoutMs` (checked every 100 ms) for a trusted answer. `null`
 * means there is no shell to ask: not embedded, or nobody answered.
 */
export const awaitShellOrigin = (timeoutMs = 3000, signal) => {
    if (typeof window === "undefined" || !embedded())
        return Promise.resolve(null);
    if (shellOrigin)
        return Promise.resolve(shellOrigin);
    sayHello();
    return new Promise(resolve => {
        const startedAt = Date.now();
        const poll = () => {
            if (shellOrigin)
                return resolve(shellOrigin);
            if (signal?.aborted || Date.now() - startedAt >= timeoutMs)
                return resolve(null);
            setTimeout(poll, 100);
        };
        poll();
    });
};
/** Install the listener and say hello. Returns a teardown for React. */
export const installHostBridge = (options = {}) => {
    if (typeof window === "undefined")
        return () => { };
    if (options.parentOrigins)
        parentOrigins = [...options.parentOrigins];
    const onMessage = (event) => {
        if (!trustedOrigin(event.origin))
            return;
        const data = event.data;
        if (data?.type === ZIBBY_BALANCE_EVENT &&
            typeof data.balance_cr === "number" && Number.isFinite(data.balance_cr)) {
            // The shell can answer hello before React's balance effect mounts.
            window.__zibbyBalanceCr = data.balance_cr;
            publishBalance(data.balance_cr);
        }
        if (data?.type === ZIBBY_CSRF_MESSAGE &&
            (data.token === null || (typeof data.token === "string" && data.token))) {
            receivedToken = data.token;
            tokenReceipts += 1;
            // Read on EVERY answer, and withdrawn by one that does not carry it —
            // a sign-out, an operator switching the app's store off, or a platform
            // that never sends the field. `data.token` gates it because the
            // platform never sends an id without one, and an app holding a name for
            // a person nobody is signed in as would say so in its UI.
            publishAppUserId(data.token ? data.app_user_id : null);
            // Comped — whether this person's runs are on Zibby — trusts the WINDOW
            // as well as the origin, like the picker's answers: only the parent
            // window says it (in a standalone dev page the parent is the page
            // itself, which is where the mock bridge posts from). A message from
            // any other frame changes nothing, either way. Gated on the token for
            // the reason `app_user_id` is: the platform only sends it for somebody
            // signed in, and a signed-out answer withdraws it.
            if (fromParent(event))
                publishComped(data.token ? data.comped : false);
            // The shell has proved which origin it is on by talking to us from it.
            // That — not a guess and not `"*"` — is where a navigation may be sent.
            shellOrigin = event.origin;
            const queued = pendingTracks.splice(0);
            for (const message of queued)
                postTelemetry(message);
            const hasAverage = typeof data.avg_action_cr === "number" && Number.isFinite(data.avg_action_cr);
            const hadActionAverages = avgActionCrByAction !== undefined;
            const actionAverages = data.avg_action_cr_by_action;
            // Each handshake is a snapshot. Missing actions must fall back, including
            // after a configuration change or a rollback to a shell without the map.
            avgActionCrByAction = actionAverages && typeof actionAverages === "object" && !Array.isArray(actionAverages)
                ? Object.fromEntries(Object.entries(actionAverages).filter(([, value]) => typeof value === "number" && Number.isFinite(value)))
                : undefined;
            if (hasAverage) {
                avgActionCr = data.avg_action_cr;
            }
            if (hasAverage || avgActionCrByAction !== undefined || hadActionAverages) {
                window.dispatchEvent(new CustomEvent(ZIBBY_QUOTE_EVENT, { detail: {
                        avg_action_cr: avgActionCr,
                        ...(avgActionCrByAction === undefined ? {} : { avg_action_cr_by_action: { ...avgActionCrByAction } }),
                    } }));
            }
        }
    };
    window.addEventListener("message", onMessage);
    const forwardErrors = options.forwardErrors !== false;
    if (forwardErrors && errorListenerUsers++ === 0) {
        window.addEventListener("error", onWindowError);
        window.addEventListener("unhandledrejection", onUnhandledRejection);
    }
    // Announce unconditionally when embedded — even with a meta tag in hand.
    // It costs one empty message, and it is what tells a cross-origin shell
    // the app is awake; an "only when tokenless" guard is one of the reasons
    // an earlier message lane never actually ran.
    sayHello();
    let stopped = false;
    return () => {
        if (stopped)
            return;
        stopped = true;
        window.removeEventListener("message", onMessage);
        if (forwardErrors && --errorListenerUsers === 0) {
            window.removeEventListener("error", onWindowError);
            window.removeEventListener("unhandledrejection", onUnhandledRejection);
        }
    };
};
