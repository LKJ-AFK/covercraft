// `zibbyFetch` — the plain-HTTP sibling of `streamZibbyAi`, for the platform's
// app-token endpoints that are NOT the AI proxy (CONTRACT.md §8).
//
// Today that is one route, `POST /api/page-text` (added 2026-09-02 for M4's
// Ad Maker): the platform fetches a public https page the user named and hands
// back its readable text, because a bundle cannot fetch a third-party site
// itself.
//
// What this is: the §3 authentication lifecycle — the `x-csrf-token` header,
// and the one re-ask-and-retry on 401/403 — applied to an ordinary request,
// with the raw `Response` handed straight back. What it is NOT: an error
// mapper. `streamZibbyAi` turns refusals into `ZibbyAiError` because it owns a
// frozen contract with a fixed set of codes; these endpoints each have their
// own small set, so the app reads `response.status` and the `error` field and
// says something specific about them.
import { ZibbyAiError } from "./client.js";
import { readCsrfToken, requestFreshToken, sameSitePath } from "./hostBridge.js";
/** The statuses that send the kit back to the host bridge for a fresh token.
 *  Both of them, unless a caller says otherwise — which is what `/api/ai`,
 *  `/api/page-text` and `/api/transcribe` all want. */
const DEFAULT_REFRESH_ON = [401, 403];
/** Does this refusal name an account on hold?
 *
 *  `403 {"error":"locked"}` is the pipeline's answer on EVERY app route,
 *  before the route runs (`x-mart/lib/zibby_web/plugs/app_token_auth.ex`), so
 *  it is never a token problem: a minted token is refused identically. Left
 *  to the lifecycle below it cost the caller both waiting windows — eight
 *  seconds — and then a second send, which on `/api/transcribe` uploads the
 *  whole recording again to buy a second refusal.
 *
 *  Read off a CLONE, so the caller still gets an unread body — `zibbyFetch`
 *  hands the raw `Response` back and the app parses it itself. Anything
 *  unreadable (a body that is not JSON, a hand-made response with no
 *  `clone`) is `false`, which is this path's behaviour as it always was.
 *
 *  **TWIN: `namesLockedAccount` in `src/client.ts` — change both.** They are
 *  deliberately two (reviewed 2026-09-18): `streamZibbyAi` does not go
 *  through this helper, sharing one would put a new name in `dist/` on a
 *  release whose export surface is pinned, and the two are not the same call
 *  — this one gates itself on the status, `client.ts`'s is gated by its
 *  caller. Four tokens of rule, pinned separately on both sides. */
const namesLockedAccount = async (response) => {
    if (response.status !== 403)
        return false;
    try {
        const body = await response.clone().json();
        return body?.error === "locked";
    }
    catch {
        return false;
    }
};
/**
 * One authenticated request to a platform endpoint, returning the raw
 * `Response`.
 *
 * `path` must be a same-origin relative path (`"/api/page-text"`). The app
 * token is attached exactly as `streamZibbyAi` attaches it, and a 401/403 —
 * the laptop that slept past every token refresh — re-asks the host bridge
 * once and retries once with whatever arrives. The re-ask names the token
 * that failed, so a shell repeating it is not mistaken for a new one
 * (`requestFreshToken`); the retry happens only on a token that changed.
 *
 * **One exception, on every endpoint: `403 {"error":"locked"}`** (additive,
 * 2026-09-18). The person's account is on hold, the token is good and a
 * minted one is refused identically, so it is handed back at once — no
 * re-ask, no second send — whatever `options.refreshOn` says. CONTRACT §3.
 * `options.refreshOn` narrows which statuses do re-ask; omitted, every status
 * behaves as it always did apart from that one body.
 *
 * A `content-type: application/json` is added when `init.body` is a string and
 * the caller set no content type, because that is what every one of these
 * endpoints takes and forgetting it is a 400 nobody enjoys debugging.
 *
 * The retry re-sends `init` as given, so a ONE-SHOT body (a `ReadableStream`,
 * say) cannot be retried — pass a string or a `Blob` if the 401 path matters.
 */
export const zibbyFetch = async (path, init = {}, options = {}) => {
    if (!sameSitePath(path)) {
        throw new ZibbyAiError("unknown", `zibbyFetch takes a same-origin path beginning with "/", got: ${String(path)}`);
    }
    const send = (token) => {
        const headers = new Headers(init.headers);
        if (token)
            headers.set("x-csrf-token", token);
        if (typeof init.body === "string" && !headers.has("content-type")) {
            headers.set("content-type", "application/json");
        }
        return fetch(path, { credentials: "same-origin", ...init, headers });
    };
    const token = readCsrfToken();
    let response = await send(token);
    const refreshOn = options.refreshOn ?? DEFAULT_REFRESH_ON;
    if (refreshOn.includes(response.status) && !(await namesLockedAccount(response))) {
        const fresh = await requestFreshToken(token);
        if (fresh && fresh !== token)
            response = await send(fresh);
    }
    return response;
};
