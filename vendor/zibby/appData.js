// The only code in an embedded app that talks to `/api/app/data` — the
// platform's per-app, per-person store of small JSON documents (CONTRACT.md
// §12, added 2026-09-18).
//
//   GET    /api/app/data                          → usage
//   GET    /api/app/data/:collection              → a page of a listing
//   GET    /api/app/data/:collection/:key         → one document
//   PUT    /api/app/data/:collection/:key         → write one  [If-Match]
//   DELETE /api/app/data/:collection/:key         → 204, whether or not it was there
//   DELETE /api/app/data                          → 204, everything, this app, this person
//
// Those six are the WHOLE surface; anything else under that prefix is a 404.
//
// THE APP NEVER NAMES A PERSON. The user and the app come off the app token
// and from nowhere else — there is no query parameter, header or body field
// through which a caller could name either, and a body carrying `user_id`,
// `app_id` or `app_user_id` is not merely ignored, it is never consulted. So
// `getAppUserId()` is a convenience for the app's own logic (a cache key, a
// "you are signed in as" line) and never a credential: an app's own backend
// must not trust an id a browser hands it.
//
// IT COSTS NOTHING. No ledger row, no credit, no balance check — which is why
// nothing here publishes a balance and nothing here has a `charged_cr`.
//
// RETRYING. Reads (`get`, `list`, `listAll`, `usage`) may be retried freely,
// and `remove` may too: a delete answers 204 whether or not the document was
// there, so a repeat after a dropped connection reports the truth rather than
// an error for work that succeeded. A `put` is the one to think about — it is
// last-write-wins without `ifVersion`, so re-sending one after a timeout can
// overwrite a newer write from another tab. Nothing here retries anything by
// itself beyond `zibbyFetch`'s one token re-ask on 401, and a `version_conflict`
// is NEVER retried by the kit: what to do with the other tab's version is the
// app's decision, not a library's.
//
// WHAT NEVER GOES IN: secrets and credentials of any kind, payment details,
// other people's personal data, and anything the app's own copy promised not
// to keep. Nothing here is encrypted beyond the platform's own storage,
// anything that can make a request with this app's token in this browser can
// read every byte of it, and an operator can see the counts and sizes. The
// person's own settings page lists what each app holds, with Export and
// Erase, and an account's data goes within 90 days of its deletion.
//
// LIVE ON zibby.run SINCE PLATFORM v0.4.35 (2026-09-18): the endpoint, the
// "Stores user data" switch, the settings page and the `app_user_id` field.
// A platform older than that has no such address, so `getAppUserId()` is
// `null` and every call here rejects with `not_available` ("This feature is
// not available yet"). Build the feature to DEGRADE, never to wait: an older
// platform, a signed-out visitor and an app nobody switched on are all the
// same case.
import { ZIBBY_APP_DATA_ENDPOINT } from "./config.js";
import { zibbyFetch } from "./fetch.js";
import { isMockEnabled } from "./client.js";
/** The platform's per-document ceiling, in bytes of the JSON the SERVER
 *  encodes for storage — never a client's claim, and never the request
 *  envelope around it. The kit mirrors it locally so an oversize document is
 *  refused before it is uploaded; the platform's own 413 quotes the same
 *  number back as `max_bytes`. */
export const ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES = 100000;
/** The platform's ceiling on documents, per person per app. A local mirror
 *  for an app that wants to show "3 of 1,000 saved"; the platform enforces it
 *  and a refusal quotes the figures it enforced. */
export const ZIBBY_APP_DATA_MAX_DOCUMENTS = 1000;
/** The platform's ceiling on total bytes, per person per app. Same story. */
export const ZIBBY_APP_DATA_MAX_BYTES = 5000000;
/** The largest `limit` a listing takes. The platform's default is 50. */
export const ZIBBY_APP_DATA_MAX_LIST_LIMIT = 100;
/** What `listAll` asks for per page when the caller names nothing. */
const LIST_ALL_PAGE_LIMIT = ZIBBY_APP_DATA_MAX_LIST_LIMIT;
/** A listing always makes progress — one document larger than a page's own
 *  byte budget is still handed back alone — so at most `ZIBBY_APP_DATA_MAX_DOCUMENTS`
 *  pages can exist. More than that is a cursor that does not advance, and
 *  `listAll` stops rather than spin. */
const LIST_ALL_MAX_PAGES = ZIBBY_APP_DATA_MAX_DOCUMENTS;
/**
 * The platform's name grammar, character for character: 1 to 64 characters,
 * lower-case letters and digits, `_`, `.` and `-`, and the first character may
 * not be `_`, `.` or `-`.
 *
 * The server anchors its own copy at the true start and the true end, because
 * in Elixir — and in PCRE, Ruby and Python — `$` ALSO matches immediately
 * before a final newline, so `"notes\n"` would otherwise be a legal name there
 * and is `400 invalid_key` instead.
 *
 * JavaScript's `$` does NOT do that without the `m` flag (checked, not
 * assumed: `/^abc$/.test("abc\n") === false`), so the regex is already exact
 * as printed. The trailing `(?![\s\S])` is belt to that brace — it says the
 * intent out loud, it survives somebody adding an `m`, and it survives the
 * pattern being copied into a language where `$` is the looser one.
 */
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$(?![\s\S])/;
/** A prefix is not a name: it may be empty and it may begin with `_`, `.` or
 *  `-`, because it is matched against the START of a key. Same anchoring. */
const PREFIX = /^[a-z0-9_.-]{0,64}$(?![\s\S])/;
/**
 * Is this a name the platform's data store will accept for a collection or a
 * key?
 *
 * Worth calling on anything built out of a person's own words — a title
 * slugified into a key, a folder name — BEFORE the write, so the app can say
 * "that name will not do" in its own words instead of handing the person a
 * refusal. The kit checks it again on every call either way.
 */
export const isAppDataName = (value) => typeof value === "string" && NAME.test(value);
/** The kit's default English words per code.
 *
 *  Every sentence here names the PROBLEM and never the data: no key, no
 *  collection name, no value. An error can be rendered on the page, logged by
 *  the app, or escape to `window.onerror` and travel to the shell's error
 *  channel — and a message carrying somebody's document key would put it in
 *  all three. */
const MESSAGES = {
    bad_request: "That request was not the shape the data store accepts.",
    invalid_key: "That name is not one the data store accepts.",
    unauthenticated: "Please sign in to use your saved data.",
    // The account itself is on hold. The app is set up, the token is good, and
    // there is nothing the app or a fresh token can do about it.
    locked: "Your account is on hold — check your Zibby account.",
    data_store_disabled: "This app is not set up to keep your data.",
    not_found: "That saved item is no longer there.",
    // No such ADDRESS: a platform that predates the store, or a shape that is
    // not one of the six. It is not a missing document, and telling somebody
    // their saved item is gone would be a false sentence about their data.
    not_available: "This feature is not available yet.",
    version_conflict: "This was changed somewhere else — reload it before saving again.",
    document_too_large: "That is too large to save.",
    quota_exceeded: "There is no room left for this app's saved data.",
    rate_limited: "Too many requests.",
    network: "Could not reach your saved data.",
    unknown: "Your saved data could not be reached.",
};
const int = (value) => typeof value === "number" && Number.isInteger(value) ? value : null;
const finiteOr = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const quotaFrom = (details) => {
    const usedBytes = int(details.used_bytes);
    const quotaBytes = int(details.quota_bytes);
    const usedDocs = int(details.used_docs);
    const quotaDocs = int(details.quota_docs);
    if (usedBytes === null || quotaBytes === null || usedDocs === null || quotaDocs === null) {
        return null;
    }
    return { usedBytes, quotaBytes, usedDocs, quotaDocs };
};
export class ZibbyAppDataError extends Error {
    /** `message` is optional: left out (or empty) the code's own English words
     *  are used, so a mock and a hand-built error say what production says. */
    constructor(code, message, opts = {}) {
        super(message || MESSAGES[code] || MESSAGES.unknown);
        this.name = "ZibbyAppDataError";
        this.code = code;
        this.status = opts.status ?? null;
        this.details = opts.details ?? {};
        this.retryAfterS = opts.retryAfterS ?? null;
        this.currentVersion = int(this.details.current_version);
        this.maxBytes = int(this.details.max_bytes);
        this.quota = quotaFrom(this.details);
    }
}
/** A refusal the kit decided by itself: no request was sent, so no status. */
const local = (code, details = {}) => new ZibbyAppDataError(code, undefined, { details: { error: code, ...details } });
/** The abort the kit raises itself, shaped exactly like the one a browser's
 *  `fetch` raises — an app catches `error.name === "AbortError"` once and it
 *  is true of every stage. */
const abortError = () => new DOMException("Aborted", "AbortError");
/** Cancel is a state, not a request: every stage asks before it spends
 *  anything, so an aborted call encodes nothing and sends nothing. */
const stopIfAborted = (signal) => {
    if (signal?.aborted)
        throw abortError();
};
/** The app's data-store mock, loaded lazily so a production bundle never
 *  ships it on the critical path — the same shape `setMockLoader` and
 *  `setTranscribeMockLoader` have:
 *
 *    setAppDataMockLoader(() => import("./myMock").then(m => m.appDataMock));
 *
 *  Pass `null` to unregister it. It is consulted only while the mock is
 *  enabled (`isMockEnabled()`), which is the same one flag the AI and
 *  transcription mocks ride. */
let mockLoader = null;
export const setAppDataMockLoader = (loader) => {
    mockLoader = loader;
};
const mockStore = async () => isMockEnabled() && mockLoader ? mockLoader() : null;
// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------
/** Every code the PLATFORM can put in an `error` field on this route: the
 *  contract's own table, plus `locked` — the pipeline's answer for an account
 *  on hold, which `AppTokenAuth` halts with on every route it guards. */
const KNOWN_CODES = new Set([
    "bad_request",
    "invalid_key",
    "unauthenticated",
    "locked",
    "data_store_disabled",
    "not_found",
    "version_conflict",
    "document_too_large",
    "quota_exceeded",
    "rate_limited",
]);
/** The status a body could not name. Every one of these is in the contract's
 *  table, so this is a fallback for a proxy that died before it could write
 *  its body — **not a second opinion**, which is why `refusalFrom` reaches for
 *  it only when the body named no code at all.
 *
 *  404 is `not_available` rather than `not_found` on purpose: the contract
 *  always writes `{"error":"not_found"}` for a document that is not there, so
 *  a 404 with no body of its own is an ADDRESS that is not there — a platform
 *  that predates the store, or a proxy. */
const CODE_BY_STATUS = {
    400: "bad_request",
    401: "unauthenticated",
    403: "data_store_disabled",
    404: "not_available",
    409: "version_conflict",
    413: "document_too_large",
    429: "rate_limited",
};
/** The answer the kit could not read: a body that is not an object, or one
 *  missing a field the platform always sends. */
const unreadable = (status = null) => new ZibbyAppDataError("unknown", "The data store returned an unreadable answer.", { status });
const retryAfterFrom = (response) => {
    const header = response.headers.get("retry-after");
    if (!header)
        return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
/** The body, or `null` when there was not one to read — and never an
 *  `AbortError` swallowed on the way. A cancel that lands while the body is
 *  being read is still the browser's own abort, and an app that catches
 *  `error.name === "AbortError"` once must be right about every stage. */
const bodyOf = async (response) => {
    try {
        return await response.json();
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        return null;
    }
};
const refusalFrom = async (response) => {
    const body = await bodyOf(response);
    const named = typeof body?.error === "string" ? body.error : "";
    // The platform's own word beats a guess from the status, ALWAYS. A body
    // that named a code the kit has never heard of is `unknown` — renaming it
    // to whichever code shares its status is how a kit says something false
    // with confidence, and every code the platform adds later lands here.
    const code = KNOWN_CODES.has(named)
        ? named
        : named !== ""
            ? "unknown"
            : CODE_BY_STATUS[response.status] ?? "unknown";
    const details = body && typeof body === "object" ? { ...body } : {};
    const retryAfterS = retryAfterFrom(response);
    if (retryAfterS !== null)
        details.retry_after_s = retryAfterS;
    const message = code === "unknown" ? `${MESSAGES.unknown} (${response.status}).` : MESSAGES[code];
    return new ZibbyAppDataError(code, message, { status: response.status, details, retryAfterS });
};
/** On this route a 403 is `data_store_disabled` — an app nobody switched on —
 *  which no token can mend, so the 401 path is the only one worth a re-ask. */
const REFRESH_ON = [401];
const send = async (path, init) => {
    try {
        return await zibbyFetch(path, init, { refreshOn: REFRESH_ON });
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        if (error instanceof ZibbyAppDataError)
            throw error;
        // Not retried: a `put` that reached the platform may already have landed,
        // and a second one would overwrite a newer write from another tab.
        throw new ZibbyAppDataError("network", MESSAGES.network);
    }
};
/**
 * A `not_found` that cannot be about a document, renamed to what it really
 * is: an address that is not there.
 *
 * The contract defines a document-level 404 in exactly two places — a `get`
 * of a document nobody wrote, and a `put` whose `ifVersion` names one that is
 * gone. Everywhere else a delete answers 204 whether or not the document was
 * there, and `usage`, `clear` and `list` have no document-level 404 at all,
 * so a 404 on one of them means the ADDRESS is missing: a platform that
 * predates the store, or a proxy. The kit only ever calls the six routed
 * shapes, so it can say that without guessing.
 *
 * Why it matters in words: "That saved item is no longer there" describes the
 * SUCCESS case of `remove`, and there is no saved item at all in a `usage` or
 * a `clear`.
 */
const asAddress = (refusal) => refusal.code === "not_found"
    ? new ZibbyAppDataError("not_available", undefined, {
        status: refusal.status,
        details: refusal.details,
        retryAfterS: refusal.retryAfterS,
    })
    : refusal;
/** Every request in this module goes through here, so there is exactly one
 *  place that turns a refusal into a `ZibbyAppDataError`.
 *
 *  `documentLevelNotFound` is true only where the contract gives a 404 about
 *  a DOCUMENT: `get`, and a `put` carrying `ifVersion`. */
const request = async (path, init, signal, documentLevelNotFound = false) => {
    stopIfAborted(signal);
    const response = await send(path, { ...init, signal });
    if (!response.ok) {
        const refusal = await refusalFrom(response);
        throw documentLevelNotFound ? refusal : asAddress(refusal);
    }
    return response;
};
const readJson = async (response) => {
    const body = await bodyOf(response);
    if (!body || typeof body !== "object") {
        throw unreadable(response.status);
    }
    return body;
};
// ---------------------------------------------------------------------------
// Local validation — the refusals whose answer is already known
// ---------------------------------------------------------------------------
const checkName = (value) => {
    // The name is NOT in the message, here or anywhere: an app that logs the
    // error, or lets it reach `window.onerror`, would otherwise publish the key
    // somebody asked it to keep private.
    if (!isAppDataName(value))
        throw local("invalid_key");
};
const checkPrefix = (value) => {
    if (typeof value !== "string" || !PREFIX.test(value))
        throw local("bad_request");
};
const checkLimit = (value) => {
    if (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > ZIBBY_APP_DATA_MAX_LIST_LIMIT) {
        throw local("bad_request");
    }
};
const checkIfVersion = (value) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw local("bad_request");
    }
};
/**
 * A NUL escape that the ENCODER produced, told apart from six ordinary
 * characters a document happens to spell.
 *
 * `JSON.stringify` writes a real NUL as a backslash, a `u` and four noughts,
 * and writes an ordinary backslash doubled — so a document whose TEXT spells
 * those six characters encodes to a doubled backslash followed by `u0000`. A
 * search for the escape alone matches both, which is the exact bug the
 * platform had and fixed (S3, 2026-09-18): a JSON tutorial's own example
 * looked like a NUL. The parity rule separates them — the encoder's escape is
 * preceded by an EVEN number of backslashes, a spelled one by an odd number.
 *
 * (Written in words on purpose. Typing the escape into this comment is how a
 * real NUL byte gets into the source file, which is legal and compiles and
 * makes every `grep` treat the file as binary.)
 */
const NUL_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u0000/;
/** The bytes the platform will count for this document: the JSON of the VALUE
 *  alone, not the `{"value": …}` envelope around it, which is what the server
 *  counts too.
 *
 *  It is a local MIRROR of the platform's arithmetic, not the platform's own:
 *  the two encoders agree on every ordinary document, and a value sitting
 *  within a byte or two of the ceiling may still be refused on the wire. The
 *  platform's answer is the authority. */
const encode = (value) => {
    let json;
    try {
        json = JSON.stringify(value);
    }
    catch {
        // A cycle, a BigInt, a getter that threw.
        throw local("bad_request");
    }
    // `undefined`, a function and a symbol all encode to nothing at all.
    if (typeof json !== "string")
        throw local("bad_request");
    if (NUL_ESCAPE.test(json))
        throw local("bad_request");
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES) {
        throw local("document_too_large", {
            max_bytes: ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES,
            bytes,
        });
    }
    return { json, bytes };
};
// ---------------------------------------------------------------------------
// Shapes off the wire
// ---------------------------------------------------------------------------
/**
 * Two fields the platform sends on every document it describes, and neither
 * has a sane default.
 *
 * A missing `version` defaulted to `0` is worse than a refusal twice over: it
 * looks like an answer, and it fails the kit's own `checkIfVersion` on the
 * next conflict-safe save, so the app is told its own request was malformed.
 * A missing `updated_at` defaulted to `""` is an `Invalid Date` for anything
 * that parses it. An answer without them is a bug on the other side, and
 * saying the answer was unreadable is the honest thing to do with it.
 */
const versionIn = (value, status) => {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw unreadable(status);
    return value;
};
const stampIn = (value, status) => {
    if (typeof value !== "string" || value === "")
        throw unreadable(status);
    return value;
};
const documentFrom = (body, status = null) => ({
    key: typeof body.key === "string" ? body.key : "",
    value: body.value,
    version: versionIn(body.version, status),
    updatedAt: stampIn(body.updated_at, status),
});
const writeFrom = (body, status = null) => ({
    key: typeof body.key === "string" ? body.key : "",
    version: versionIn(body.version, status),
    updatedAt: stampIn(body.updated_at, status),
});
const itemFrom = (row, status = null) => {
    const item = {
        key: typeof row.key === "string" ? row.key : "",
        version: versionIn(row.version, status),
        bytes: finiteOr(row.bytes, 0),
        updatedAt: stampIn(row.updated_at, status),
    };
    // Only when the platform sent one: `"value" in item` is how an app tells
    // "I did not ask for values" from "the value stored here is null".
    if ("value" in row)
        item.value = row.value;
    return item;
};
const pageFrom = (body, status = null) => ({
    items: Array.isArray(body.items)
        ? body.items
            .filter((row) => row && typeof row === "object")
            .map((row) => itemFrom(row, status))
        : [],
    nextCursor: typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null,
});
const usageFrom = (body) => ({
    collections: Array.isArray(body.collections)
        ? body.collections
            .filter((row) => row && typeof row === "object" && typeof row.name === "string")
            .map((row) => ({
            name: row.name,
            count: finiteOr(row.count, 0),
            bytes: finiteOr(row.bytes, 0),
        }))
        : [],
    usedBytes: finiteOr(body.used_bytes, 0),
    quotaBytes: finiteOr(body.quota_bytes, ZIBBY_APP_DATA_MAX_BYTES),
    usedDocs: finiteOr(body.used_docs, 0),
    quotaDocs: finiteOr(body.quota_docs, ZIBBY_APP_DATA_MAX_DOCUMENTS),
});
// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------
// Every name is checked against the grammar before it is put in a path, and
// that grammar admits only characters a URL leaves alone — so this encode can
// never change one, and it is here as the belt to the grammar's braces.
const documentPath = (collection, key) => `${ZIBBY_APP_DATA_ENDPOINT}/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`;
const listPath = (collection, options) => {
    const query = [];
    if (options.prefix !== undefined)
        query.push(`prefix=${encodeURIComponent(options.prefix)}`);
    if (options.limit !== undefined)
        query.push(`limit=${options.limit}`);
    if (options.cursor !== undefined)
        query.push(`cursor=${encodeURIComponent(options.cursor)}`);
    if (options.values)
        query.push("values=1");
    const path = `${ZIBBY_APP_DATA_ENDPOINT}/${encodeURIComponent(collection)}`;
    return query.length ? `${path}?${query.join("&")}` : path;
};
// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------
const getDocument = async (collection, key, options) => {
    stopIfAborted(options.signal);
    checkName(collection);
    checkName(key);
    const mock = await mockStore();
    if (mock) {
        const answer = await mock.get(collection, key, options);
        stopIfAborted(options.signal);
        return answer;
    }
    try {
        const response = await request(documentPath(collection, key), { method: "GET" }, options.signal, 
        // This is one of the two addresses where a 404 can be about a DOCUMENT.
        true);
        return documentFrom(await readJson(response), response.status);
    }
    catch (error) {
        // A document nobody wrote is not an error — it is the answer to "is there
        // one?", and an app that had to wrap every read in a try/catch to ask that
        // question would soon stop checking the code at all. A 404 that did NOT
        // name the contract's code is `not_available` and is thrown: an address
        // that is not there must never read as an empty store.
        if (error instanceof ZibbyAppDataError && error.code === "not_found")
            return null;
        throw error;
    }
};
const putDocument = async (collection, key, value, options) => {
    stopIfAborted(options.signal);
    checkName(collection);
    checkName(key);
    if (options.ifVersion !== undefined)
        checkIfVersion(options.ifVersion);
    // Before the mock as well as before the wire: a dev build refuses exactly
    // what production refuses, which is the only way the mock is worth having.
    const { json } = encode(value);
    const mock = await mockStore();
    if (mock) {
        const answer = await mock.put(collection, key, value, options);
        stopIfAborted(options.signal);
        return answer;
    }
    const headers = {};
    if (options.ifVersion !== undefined)
        headers["if-match"] = String(options.ifVersion);
    const response = await request(documentPath(collection, key), 
    // Built from the already-encoded value rather than re-stringified, so the
    // bytes that were measured are the bytes that travel.
    { method: "PUT", headers, body: `{"value":${json}}` }, options.signal, 
    // Only a write that named a version can be told "that document is gone".
    // Without one a `put` CREATES, so a 404 there is an address, not a
    // document.
    options.ifVersion !== undefined);
    return writeFrom(await readJson(response), response.status);
};
const removeDocument = async (collection, key, options) => {
    stopIfAborted(options.signal);
    checkName(collection);
    checkName(key);
    const mock = await mockStore();
    if (mock) {
        await mock.remove(collection, key, options);
        stopIfAborted(options.signal);
        return;
    }
    await request(documentPath(collection, key), { method: "DELETE" }, options.signal);
};
const listCollection = async (collection, options) => {
    stopIfAborted(options.signal);
    checkName(collection);
    if (options.prefix !== undefined)
        checkPrefix(options.prefix);
    if (options.limit !== undefined)
        checkLimit(options.limit);
    if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor)) {
        throw local("bad_request");
    }
    const mock = await mockStore();
    if (mock) {
        const answer = await mock.list(collection, options);
        stopIfAborted(options.signal);
        return answer;
    }
    const response = await request(listPath(collection, options), { method: "GET" }, options.signal);
    return pageFrom(await readJson(response), response.status);
};
const listAllOf = async (collection, options) => {
    const limit = options.pageLimit ?? LIST_ALL_PAGE_LIMIT;
    checkLimit(limit);
    const items = [];
    let cursor;
    for (let page = 0; page < LIST_ALL_MAX_PAGES; page += 1) {
        stopIfAborted(options.signal);
        const answer = await listCollection(collection, {
            prefix: options.prefix,
            values: options.values,
            signal: options.signal,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
        });
        items.push(...answer.items);
        if (answer.nextCursor === null)
            return items;
        // A cursor that hands back the one just used is a cursor that does not
        // advance, and it is knowable on the SECOND request — one wasted call
        // rather than 1,000. At 120 reads a minute per person per app, spinning
        // to the page ceiling would spend the whole budget on a broken cursor and
        // pile a thousand copies of the same page into memory on the way.
        if (answer.nextCursor === cursor)
            throw new ZibbyAppDataError("unknown", "The listing did not end.");
        cursor = answer.nextCursor;
    }
    // The backstop: a page always makes progress, so a listing that has not
    // ended after as many pages as the platform allows documents is broken in
    // some other way. Stopping with a refusal beats spinning for ever.
    throw new ZibbyAppDataError("unknown", "The listing did not end.");
};
/** Keyed on the name AS GIVEN, and deliberately not on `String(name)`:
 *  `String(undefined)` is `"undefined"`, which matches the platform's name
 *  grammar, so a coerced name is a document written somewhere nobody meant
 *  and no refusal anywhere. A `Map` takes any key, so the value travels
 *  through unchanged and `checkName` refuses it on the first call. */
const collections = new Map();
const makeCollection = (name) => ({
    name,
    get: (key, options = {}) => getDocument(name, key, options),
    put: (key, value, options = {}) => putDocument(name, key, value, options),
    remove: (key, options = {}) => removeDocument(name, key, options),
    list: (options = {}) => listCollection(name, options),
    listAll: (options = {}) => listAllOf(name, options),
});
/**
 * The app's own small JSON store, kept by the platform against the signed-in
 * person and this app — so a resume saved on a laptop is there on a phone.
 *
 * ```ts
 * import { appData, ZibbyAppDataError } from "@zibby-run/app-kit";
 *
 * const resumes = appData.collection("resumes");
 *
 * const saved = await resumes.get("cv-2026");          // null when there is none
 * const write = await resumes.put("cv-2026", draft, {  // the conflict-safe save
 *   ifVersion: saved?.version,
 * });
 * const all = await resumes.listAll();                 // newest-CREATED first
 * ```
 *
 * **The platform half is live since platform v0.4.35 (2026-09-18).** An older
 * platform has no such address, so every call here rejects with
 * `not_available` and `getAppUserId()` is `null`.
 *
 * Every call needs the app to have been switched on for user data by an
 * operator at publish; without that the platform answers
 * `data_store_disabled` and `getAppUserId()` is `null`. Build the feature to
 * degrade — an app that cannot reach the store must still work, because a
 * signed-out visitor is the same case.
 *
 * `collection(name)` does not validate eagerly and does not touch the network:
 * the name is checked on every call, so every refusal in this module has one
 * shape, a rejected promise carrying a `ZibbyAppDataError`. An abort re-throws
 * the browser's own `AbortError` instead, exactly as `transcribe` does.
 */
export const appData = {
    /** A handle on one collection. Cheap and cached: two calls with the same
     *  name hand back the same object. */
    collection(name) {
        const existing = collections.get(name);
        if (existing)
            return existing;
        // Not coerced and not validated here: a name that is not a string — a
        // `settings?.folder` that was never set, a value off JSON, a JavaScript
        // app — is refused as `invalid_key` on the first call, which is the one
        // shape every refusal in this module has.
        const made = makeCollection(name);
        collections.set(name, made);
        return made;
    },
    /** What this app is holding for this person: the per-collection counts and
     *  bytes (by name, ascending, empty collections absent) and the four
     *  figures a quota refusal quotes. */
    async usage(options = {}) {
        stopIfAborted(options.signal);
        const mock = await mockStore();
        if (mock) {
            const answer = await mock.usage(options);
            stopIfAborted(options.signal);
            return answer;
        }
        const response = await request(ZIBBY_APP_DATA_ENDPOINT, { method: "GET" }, options.signal);
        return usageFrom(await readJson(response));
    },
    /** Erase everything this person has in this app, in every collection. The
     *  person can do the same thing from their own settings page; this is the
     *  app's own "forget me" button, and it is not undoable. */
    async clear(options = {}) {
        stopIfAborted(options.signal);
        const mock = await mockStore();
        if (mock) {
            await mock.clear(options);
            stopIfAborted(options.signal);
            return;
        }
        await request(ZIBBY_APP_DATA_ENDPOINT, { method: "DELETE" }, options.signal);
    },
};
