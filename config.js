// Contract constants shared by every Zibby-embedded app. Values here are the
// PLATFORM's side of the bargain — an app changes them only when the platform
// does. App-specific configuration (which actions exist, their models, budgets
// and quoted costs) belongs in the app's own config module, not here.
/** Same-origin, relative on purpose: the app is served under a path prefix or
 *  on a per-app origin and must never learn the host it is mounted on. */
export const ZIBBY_AI_ENDPOINT = "/api/ai";
/** The page-text endpoint (CONTRACT.md §8). Same-origin and relative for the
 *  same reason as the AI one, and reached with `zibbyFetch`. */
export const ZIBBY_PAGE_TEXT_ENDPOINT = "/api/page-text";
/** The speech-to-text endpoint (CONTRACT.md §8, additive 2026-09-17). Same
 *  origin rules again, and reached through `transcribe` — which is
 *  `zibbyFetch` with the contract's body, its refusal table and the balance
 *  publish around it. Unlike the other §8 route this one COSTS CREDITS and
 *  mints an `x-zibby-request-id`. */
export const ZIBBY_TRANSCRIBE_ENDPOINT = "/api/transcribe";
/** The app data store (CONTRACT.md §12, additive 2026-09-18). Same origin
 *  rules again, and reached through `appData` — which is `zibbyFetch` with the
 *  contract's paths, its name grammar and its refusal table around it. It is
 *  the ROOT of six addresses: this path itself (usage and clear-everything),
 *  `/:collection` (a listing) and `/:collection/:key` (one document). It costs
 *  no credits and mints no request id. */
export const ZIBBY_APP_DATA_ENDPOINT = "/api/app/data";
/** The app files store (CONTRACT.md §14, additive, 0.6.0). Same origin rules
 *  again, and reached through `files` — `zibbyFetch` with the contract's
 *  paths and refusal table, plus the one request that does NOT go to this
 *  origin: the signed `PUT` of the bytes, straight to storage. It costs no
 *  credits. The platform half is live on zibby.run since platform v0.5.0
 *  (2026-10-02); see CONTRACT §14 for what an older platform answers. */
export const ZIBBY_APP_FILES_ENDPOINT = "/api/app/files";
/** Background transcription of a stored recording (CONTRACT.md §15,
 *  additive, 0.6.0), reached through `transcribeJob` and `jobs`. Like
 *  `/api/transcribe` it COSTS CREDITS, once, when the job succeeds. Same
 *  availability as the files store. */
export const ZIBBY_TRANSCRIBE_JOBS_ENDPOINT = "/api/transcribe/jobs";
/** Where "top up" sends the user. Pass it to `navigateHost` — NOT to an
 *  `href` with `target="_top"`: on a per-app origin that resolves against the
 *  app's own origin and 404s, which is the whole reason the navigate message
 *  exists (CONTRACT.md §1 and §4). */
export const ZIBBY_CREDITS_PATH = "/credits";
/** Meta tags a SAME-ORIGIN serving shell may render to hand the app a token.
 *  First name wins; the second is Phoenix's own convention and is accepted so
 *  a shell can reuse an existing tag. On a per-app origin no meta exists and
 *  the token arrives over the host bridge instead. */
export const ZIBBY_CSRF_META_NAMES = ["zibby-csrf-token", "csrf-token"];
