// The only code in an embedded app that talks to `/api/app/files` — the
// platform's per-app, per-person folder of FILES (CONTRACT.md §14, additive,
// 0.6.0) — and the only code that asks the Zibby shell for the person's
// file picker.
//
//   POST   /api/app/files                 → reserve: {file, upload: {url, method, headers, expires_at}}
//   PUT    <upload.url>                   → the bytes, straight to storage, with EXACTLY upload.headers
//   POST   /api/app/files/:id/complete    → {file}   (the reservation becomes ready)
//   GET    /api/app/files?limit=&cursor=  → {items, next_cursor, used_bytes, quota_bytes}
//   GET    /api/app/files/:id             → {file (+ access), download: {url, expires_at} | null}
//   DELETE /api/app/files/:id             → 204
//
// THE APP NEVER NAMES A PERSON, as with app data (§12): the folder is the app
// token's person × the token's app, and nothing in a request can name
// another. A file from ANOTHER app's folder reaches this one only when the
// person picks it in the shell's picker (`files.pick`), and then read-only.
//
// IT COSTS NOTHING. Storage is free inside the quota — 5 GB and 10,000 files
// per person per app. Recordings (every `audio/*` file) are deleted 30 days
// after their upload completes; every other file stays until the person or
// the app deletes it.
//
// NEEDS THE APP'S "Stores user files" SWITCH. An operator turns it on at
// publish (it is separate from "Stores user data"); until then every call
// answers `file_store_disabled`, and the person can do nothing about it —
// never tell them to sign in.
//
// AVAILABILITY. The platform half is live on zibby.run since platform v0.5.0
// (2026-10-02), the release after v0.4.36. A platform older than that has no
// such address: every call
// rejects `not_available` and `pick` resolves with reason `unavailable` —
// the kit asks the files store once per page before its first pick, because
// an older shell drops the pick request without answering. Build the feature
// to DEGRADE, exactly as for app data.
//
// RETRYING. Reads (`list`, `get`) may be retried freely. `delete` may too
// (a second one answers `not_found`, which is the truth). An `upload` that
// failed part-way can be started again from the top — the kit removes the
// half-made reservation on the way out, best-effort, and one it could not
// remove expires by itself within a day. Nothing here retries by itself
// beyond `zibbyFetch`'s one token re-ask on 401.
import { ZIBBY_APP_FILES_ENDPOINT } from "./config.js";
export { ZIBBY_APP_FILES_ENDPOINT };
import { zibbyFetch } from "./fetch.js";
import { isMockEnabled } from "./client.js";
import { awaitShellOrigin, isShellReply } from "./hostBridge.js";
/** The largest recording (any `audio/*` file): 25 MB in binary units —
 *  26,214,400 bytes, the transcription provider's own ceiling. */
export const ZIBBY_FILES_MAX_AUDIO_BYTES = 26214400;
/** The largest file of any other type: 100 MB (104,857,600 bytes). */
export const ZIBBY_FILES_MAX_OTHER_BYTES = 104857600;
/** Everything one person keeps in one app, reserved and ready: 5 GB. */
export const ZIBBY_FILES_QUOTA_BYTES = 5368709120;
/** Files one person keeps in one app. */
export const ZIBBY_FILES_MAX_FILES = 10000;
/** The largest `limit` a listing takes; the platform's default is 50. */
export const ZIBBY_FILES_MAX_LIST_LIMIT = 100;
/** Days a recording lives after its upload completes. */
export const ZIBBY_FILES_AUDIO_RETENTION_DAYS = 30;
/** Seconds a download link lives. It is a BEARER link: whoever holds it can
 *  fetch the file until then — never log it, never put it in analytics. */
export const ZIBBY_FILES_DOWNLOAD_TTL_S = 300;
/** The kit's English per code. Every sentence names the PROBLEM, never the
 *  file: a name is the person's content, and an error travels to logs and to
 *  `window.onerror`. */
const MESSAGES = {
    bad_request: "That request was not the shape the files store accepts.",
    purpose_mismatch: "A recording is always stored as audio.",
    unauthenticated: "Please sign in to use your files.",
    locked: "Your account is on hold — check your Zibby account.",
    file_store_disabled: "This app is not set up to keep your files.",
    not_found: "That file is no longer there.",
    not_available: "This feature is not available yet.",
    upload_missing: "The file did not finish uploading.",
    upload_failed: "The file could not be uploaded.",
    size_mismatch: "The file changed while it was uploading.",
    file_too_large: "That file is too large to keep.",
    quota_exceeded: "There is no room left for this app's files.",
    too_many_files: "This app is keeping as many files as it can.",
    unsupported_type: "That kind of file cannot be kept here.",
    rate_limited: "Too many requests.",
    storage_unavailable: "File storage is not available right now.",
    network: "Could not reach your files.",
    unknown: "Your files could not be reached.",
};
const int = (value) => typeof value === "number" && Number.isInteger(value) ? value : null;
export class ZibbyFilesError extends Error {
    constructor(code, message, opts = {}) {
        super(message || MESSAGES[code] || MESSAGES.unknown);
        this.name = "ZibbyFilesError";
        this.code = code;
        this.status = opts.status ?? null;
        this.details = opts.details ?? {};
        this.retryAfterS = opts.retryAfterS ?? null;
        this.maxBytes = int(this.details.max_bytes);
        this.maxFiles = int(this.details.max_files);
        const used = int(this.details.used_bytes);
        const quota = int(this.details.quota_bytes);
        this.quota = used !== null && quota !== null ? { usedBytes: used, quotaBytes: quota } : null;
    }
}
/** A refusal the kit decided by itself: nothing was sent, so no status. */
const local = (code, details = {}, message) => new ZibbyFilesError(code, message, { details: { error: code, ...details } });
const abortError = () => new DOMException("Aborted", "AbortError");
const stopIfAborted = (signal) => {
    if (signal?.aborted)
        throw abortError();
};
let mockLoader = null;
/** The files mock, loaded lazily — the same shape as the other loaders:
 *
 *    setFilesMockLoader(() => import("./myMock").then(m => m.filesMock));
 *
 *  Consulted only while the one mock flag is on (`isMockEnabled()`). Pass
 *  `null` to unregister it. */
export const setFilesMockLoader = (loader) => {
    mockLoader = loader;
};
const mockFiles = async () => isMockEnabled() && mockLoader ? mockLoader() : null;
// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------
const KNOWN_CODES = new Set([
    "bad_request",
    "purpose_mismatch",
    "unauthenticated",
    "locked",
    "file_store_disabled",
    "not_found",
    "upload_missing",
    "size_mismatch",
    "file_too_large",
    "quota_exceeded",
    "too_many_files",
    "unsupported_type",
    "rate_limited",
    "storage_unavailable",
]);
/** A status whose body named no code — a proxy, or an older platform. 404 is
 *  `not_available`: the platform always NAMES `not_found` for a missing file,
 *  so a bare 404 is an address that is not there (an older platform answers
 *  its app origins' unknown paths with a plain-text 404). */
const CODE_BY_STATUS = {
    400: "bad_request",
    401: "unauthenticated",
    403: "file_store_disabled",
    404: "not_available",
    409: "upload_missing",
    413: "file_too_large",
    415: "unsupported_type",
    429: "rate_limited",
    503: "storage_unavailable",
};
const retryAfterFrom = (response) => {
    const header = response.headers.get("retry-after");
    if (!header)
        return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
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
/** The platform's own word beats a guess from the status, ALWAYS: a code
 *  the kit has never heard of is `unknown`, never whichever code shares its
 *  status. */
const refusalFrom = async (response) => {
    const body = await bodyOf(response);
    const named = typeof body?.error === "string" ? body.error : "";
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
    return new ZibbyFilesError(code, message, { status: response.status, details, retryAfterS });
};
/** A 403 here is `file_store_disabled` — no token mends it — so only a 401
 *  is worth the token re-ask (the reasoning `appData` gives). */
const REFRESH_ON = [401];
const request = async (path, init, signal) => {
    stopIfAborted(signal);
    let response;
    try {
        response = await zibbyFetch(path, { ...init, signal }, { refreshOn: REFRESH_ON });
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        throw new ZibbyFilesError("network");
    }
    if (!response.ok)
        throw await refusalFrom(response);
    return response;
};
const readJson = async (response) => {
    const body = await bodyOf(response);
    if (!body || typeof body !== "object") {
        throw new ZibbyFilesError("unknown", "The files store returned an unreadable answer.", {
            status: response.status,
        });
    }
    return body;
};
const str = (value) => (typeof value === "string" ? value : null);
/** A FILE off the wire, in the kit's names. An answer without an id is not a
 *  file the app can do anything with, and is refused as unreadable. */
export const fileFrom = (raw, status = null) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || raw.id === "") {
        throw new ZibbyFilesError("unknown", "The files store returned an unreadable answer.", { status });
    }
    const file = {
        id: raw.id,
        name: str(raw.name) ?? "",
        contentType: str(raw.content_type) ?? "application/octet-stream",
        bytes: typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? raw.bytes : 0,
        kind: raw.kind === "result" ? "result" : "upload",
        purpose: raw.purpose === "audio" ? "audio" : "other",
        status: raw.status === "ready" ? "ready" : "reserved",
        createdAt: str(raw.created_at) ?? "",
        completedAt: str(raw.completed_at),
        expiresAt: str(raw.expires_at),
    };
    if (raw.access === "own" || raw.access === "granted")
        file.access = raw.access;
    return file;
};
const downloadFrom = (raw) => raw && typeof raw === "object" && typeof raw.url === "string" && raw.url
    ? { url: raw.url, expiresAt: str(raw.expires_at) ?? "" }
    : null;
// ---------------------------------------------------------------------------
// Local checks — the refusals whose answer is already known
// ---------------------------------------------------------------------------
/** The platform's media-type grammar (`Zibby.AppFiles.Limits.essence/1`):
 *  lower-cased, parameters dropped. `null` for anything else. */
const essence = (raw) => {
    if (typeof raw !== "string")
        return null;
    const value = raw.split(";", 1)[0].trim().toLowerCase();
    return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$(?![\s\S])/.test(value)
        ? value
        : null;
};
/** The types a browser EXECUTES when it opens them — refused whatever their
 *  family, because every file here can be downloaded again. */
const EXECUTABLE = new Set(["image/svg+xml", "text/html", "text/javascript", "text/ecmascript", "text/xml"]);
/** The platform's allow-list: recordings, pictures, text, JSON and PDF,
 *  minus the executable ones. The platform checks it again; this spares an
 *  app the round trip, and it is why `unsupported_type` can have
 *  `status: null`. */
const allowedType = (type) => !EXECUTABLE.has(type) &&
    (type.startsWith("audio/") ||
        type.startsWith("image/") ||
        type.startsWith("text/") ||
        type === "application/json" ||
        type === "application/pdf");
const isBlob = (value) => typeof Blob !== "undefined" && value instanceof Blob;
/** A file id, from a string or from anything carrying `id` (a `ZibbyFile`, a
 *  `PickedFile`). The id goes into a path, so it is refused unless it is the
 *  platform's shape. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
export const fileIdOf = (file) => {
    const id = typeof file === "string"
        ? file
        : file && typeof file === "object" && typeof file.id === "string"
            ? file.id
            : null;
    return id !== null && UUID.test(id) ? id : null;
};
const checkedId = (file) => {
    const id = fileIdOf(file);
    if (id === null)
        throw local("bad_request", {}, "That is not a file id.");
    return id;
};
const ticketFrom = (raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.url !== "string" || !raw.url)
        return null;
    const headers = {};
    if (raw.headers && typeof raw.headers === "object") {
        for (const [name, value] of Object.entries(raw.headers)) {
            if (typeof value === "string")
                headers[name] = value;
        }
    }
    return { url: raw.url, method: typeof raw.method === "string" ? raw.method : "PUT", headers };
};
/**
 * PUT the bytes to the signed URL. Three rules, each load-bearing:
 *
 *   * EXACTLY the headers the platform signed, and no others. On Google
 *     Cloud Storage the type, the exact size range and create-only
 *     (`x-goog-if-generation-match: 0`) are part of the signature; a header
 *     missing or added is a `403` from storage.
 *   * No app token and no cookies (`credentials: "omit"`). The URL is its
 *     own credential, the request goes to another origin, and the token must
 *     never leave for one.
 *   * Progress needs `XMLHttpRequest` — `fetch` reports none for an upload —
 *     so it is used when `onProgress` is given and the browser has it.
 */
const putBytes = (ticket, file, options) => {
    const failed = (status) => new ZibbyFilesError("upload_failed", undefined, {
        status,
        details: { error: "upload_failed", ...(status === null ? {} : { upload_status: status }) },
    });
    if (options.onProgress && typeof XMLHttpRequest !== "undefined") {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const onAbort = () => xhr.abort();
            xhr.open(ticket.method, ticket.url, true);
            xhr.withCredentials = false;
            for (const [name, value] of Object.entries(ticket.headers))
                xhr.setRequestHeader(name, value);
            xhr.upload.onprogress = event => {
                try {
                    options.onProgress?.({ loaded: event.loaded, total: file.size });
                }
                catch {
                    // An app's progress callback that throws must not end the upload.
                }
            };
            xhr.onload = () => {
                options.signal?.removeEventListener("abort", onAbort);
                if (xhr.status >= 200 && xhr.status < 300)
                    resolve();
                else
                    reject(failed(xhr.status));
            };
            xhr.onerror = () => {
                options.signal?.removeEventListener("abort", onAbort);
                reject(failed(null));
            };
            xhr.onabort = () => {
                options.signal?.removeEventListener("abort", onAbort);
                reject(abortError());
            };
            options.signal?.addEventListener("abort", onAbort);
            xhr.send(file);
        });
    }
    return fetch(ticket.url, {
        method: ticket.method,
        headers: ticket.headers,
        body: file,
        credentials: "omit",
        mode: "cors",
        signal: options.signal,
    }).then(response => {
        if (!response.ok)
            throw failed(response.status);
        options.onProgress?.({ loaded: file.size, total: file.size });
    }, (error) => {
        if (error?.name === "AbortError")
            throw error;
        throw failed(null);
    });
};
/** Take back a reservation whose upload did not finish, so its bytes stop
 *  counting against the quota. Best-effort: a failure here is not the error
 *  the caller needs to see, and an abandoned reservation expires by itself. */
const abandon = async (id) => {
    try {
        await zibbyFetch(`${ZIBBY_APP_FILES_ENDPOINT}/${encodeURIComponent(id)}`, { method: "DELETE" }, { refreshOn: REFRESH_ON });
    }
    catch {
        // Nothing to do.
    }
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ---------------------------------------------------------------------------
// The picker, over the host bridge
// ---------------------------------------------------------------------------
export const ZIBBY_PICK_FILE_MESSAGE = "zibby:pick_file";
export const ZIBBY_PICKED_MESSAGE = "zibby:picked";
export const ZIBBY_PICK_CANCELLED_MESSAGE = "zibby:pick_cancelled";
/** The shell's own rule for `accept` (`MEDIA_TYPE` in its bridge hook),
 *  character for character after the same trim and lower-casing — so a
 *  malformed one is answered here with the reason the shell would give, and
 *  nothing is posted. */
const ACCEPT_ENTRY = /^(?:\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62}))$(?![\s\S])/;
const validAccept = (accept) => accept === undefined ||
    (Array.isArray(accept) &&
        accept.length <= 20 &&
        accept.every(entry => typeof entry === "string" && ACCEPT_ENTRY.test(entry.trim().toLowerCase())));
let pickInFlight = false;
let pickSeq = 0;
/**
 * Does this platform have the files store — and so the picker? Asked once per
 * page, before the first pick is posted.
 *
 * A shell older than the picker answers the handshake but DROPS
 * `zibby:pick_file` without a word, and the picker has no timeout (a person
 * may leave it open), so a pick sent there would never settle. The files
 * store and the picker came in the same platform release, so the store's
 * answer stands for both: `not_available` (no such address) means there is
 * no picker either, and the pick resolves `unavailable` without asking.
 *
 * Only a definite answer is kept for the page: a reply the platform wrote
 * (`not_available` included, and `file_store_disabled`, `unauthenticated`
 * and the like, which prove the address exists). A network failure, a
 * proxy's unreadable 5xx or an abort decides nothing — the pick then goes to
 * the shell exactly as before, and the next pick asks again.
 */
let filesStoreProbe = null;
const probeFilesStore = async (signal) => {
    if (filesStoreProbe)
        return filesStoreProbe;
    try {
        await request(`${ZIBBY_APP_FILES_ENDPOINT}?limit=1`, { method: "GET" }, signal);
        filesStoreProbe = "available";
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        if (!(error instanceof ZibbyFilesError))
            return null;
        if (error.code === "not_available")
            filesStoreProbe = "unavailable";
        else if (error.code !== "network" && error.code !== "unknown")
            filesStoreProbe = "available";
    }
    return filesStoreProbe;
};
/** A request id the shell accepts (1–64 of `[A-Za-z0-9_.:-]`) and that no
 *  other pick in this page shares. */
const newRequestId = () => {
    pickSeq += 1;
    const random = Math.random().toString(36).slice(2, 10);
    return `pick-${Date.now().toString(36)}-${pickSeq}-${random}`;
};
const pickedFrom = (raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !UUID.test(raw.id))
        return null;
    return {
        id: raw.id,
        name: str(raw.name) ?? "",
        contentType: str(raw.content_type) ?? "application/octet-stream",
        bytes: typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? raw.bytes : 0,
    };
};
const pickOverBridge = async (options) => {
    const cancelled = (reason) => ({ file: null, reason });
    if (!validAccept(options.accept))
        return cancelled("bad_request");
    // One pick at a time, answered here as the shell would answer a second.
    if (pickInFlight)
        return cancelled("busy");
    if (typeof window === "undefined")
        return cancelled("unavailable");
    pickInFlight = true;
    try {
        const origin = await awaitShellOrigin(3000, options.signal);
        stopIfAborted(options.signal);
        // No shell to draw it: not embedded, or nobody answered the handshake.
        if (!origin)
            return cancelled("unavailable");
        // A platform older than the files store has no picker either, and its
        // shell would never answer (see `probeFilesStore`).
        if ((await probeFilesStore(options.signal)) === "unavailable")
            return cancelled("unavailable");
        stopIfAborted(options.signal);
        const requestId = newRequestId();
        return await new Promise((resolve, reject) => {
            const done = () => {
                window.removeEventListener("message", onMessage);
                options.signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                done();
                reject(abortError());
            };
            const onMessage = (event) => {
                // The parent window, on the origin that answered the handshake — and
                // nothing else. A forged pick from another frame inside the app is
                // ignored, not believed (the picker review's N6).
                if (!isShellReply(event))
                    return;
                const data = event.data;
                if (!data || data.request_id !== requestId)
                    return;
                if (data.type === ZIBBY_PICKED_MESSAGE) {
                    const file = pickedFrom(data.file);
                    if (!file)
                        return;
                    done();
                    resolve({ file, reason: null });
                }
                else if (data.type === ZIBBY_PICK_CANCELLED_MESSAGE) {
                    done();
                    resolve(cancelled(typeof data.reason === "string" && data.reason ? data.reason : "cancelled"));
                }
            };
            window.addEventListener("message", onMessage);
            options.signal?.addEventListener("abort", onAbort);
            const message = { type: ZIBBY_PICK_FILE_MESSAGE, request_id: requestId };
            if (options.accept !== undefined)
                message.accept = options.accept.map(entry => entry.trim());
            try {
                window.parent.postMessage(message, origin);
            }
            catch {
                done();
                resolve(cancelled("unavailable"));
            }
        });
    }
    finally {
        pickInFlight = false;
    }
};
// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------
const uploadFile = async (file, options = {}) => {
    stopIfAborted(options?.signal);
    if (!isBlob(file))
        throw local("bad_request", {}, "No file to upload.");
    if (file.size <= 0)
        throw local("bad_request", {}, "That file is empty.");
    const type = essence(options.contentType ?? file.type);
    if (type === null) {
        throw local("bad_request", {}, "The file has no media type; pass contentType.");
    }
    if (!allowedType(type))
        throw local("unsupported_type");
    const purpose = type.startsWith("audio/") ? "audio" : "other";
    if (options.purpose !== undefined && options.purpose !== purpose) {
        // The platform's rule: a recording is always audio, so it always expires
        // — an app cannot keep one for ever by calling it something else.
        throw local("purpose_mismatch");
    }
    const max = purpose === "audio" ? ZIBBY_FILES_MAX_AUDIO_BYTES : ZIBBY_FILES_MAX_OTHER_BYTES;
    if (file.size > max)
        throw local("file_too_large", { max_bytes: max, bytes: file.size });
    const given = options.name ?? (typeof file.name === "string" ? file.name : "");
    const name = given.trim() || "Untitled";
    const mock = await mockFiles();
    if (mock) {
        const answer = await mock.upload(file, { name, contentType: type, purpose }, options);
        stopIfAborted(options.signal);
        return answer;
    }
    // 1. The reservation. The type travels as the caller wrote it (parameters
    //    and all); the platform stores its essence.
    const body = {
        name,
        content_type: options.contentType ?? file.type,
        bytes: file.size,
    };
    if (options.purpose !== undefined)
        body.purpose = options.purpose;
    const reserved = await readJson(await request(ZIBBY_APP_FILES_ENDPOINT, { method: "POST", body: JSON.stringify(body) }, options.signal));
    const reservation = fileFrom(reserved.file);
    const ticket = ticketFrom(reserved.upload);
    if (!ticket) {
        await abandon(reservation.id);
        throw new ZibbyFilesError("unknown", "The files store returned an unreadable answer.", { status: 201 });
    }
    // 2. The bytes, straight to storage.
    try {
        stopIfAborted(options.signal);
        await putBytes(ticket, file, options);
    }
    catch (error) {
        await abandon(reservation.id);
        throw error;
    }
    // 3. Completion. One patient second try on `upload_missing`: storage has
    //    answered the PUT, so a completion that cannot see the object yet is a
    //    moment early, not a failure.
    const completePath = `${ZIBBY_APP_FILES_ENDPOINT}/${encodeURIComponent(reservation.id)}/complete`;
    try {
        let response;
        try {
            response = await request(completePath, { method: "POST" }, options.signal);
        }
        catch (error) {
            if (!(error instanceof ZibbyFilesError) || error.code !== "upload_missing")
                throw error;
            await sleep(750);
            response = await request(completePath, { method: "POST" }, options.signal);
        }
        return fileFrom((await readJson(response)).file, response.status);
    }
    catch (error) {
        // A size mismatch leaves a reservation nobody can finish; an abort or a
        // missing upload leaves one nobody will. Take it back either way.
        if (error?.name === "AbortError" || (error instanceof ZibbyFilesError && error.code !== "network")) {
            await abandon(reservation.id);
        }
        throw error;
    }
};
const listFiles = async (options = {}) => {
    stopIfAborted(options.signal);
    if (options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > ZIBBY_FILES_MAX_LIST_LIMIT)) {
        throw local("bad_request");
    }
    if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor)) {
        throw local("bad_request");
    }
    const mock = await mockFiles();
    if (mock) {
        const answer = await mock.list(options);
        stopIfAborted(options.signal);
        return answer;
    }
    const query = [];
    if (options.limit !== undefined)
        query.push(`limit=${options.limit}`);
    if (options.cursor !== undefined)
        query.push(`cursor=${encodeURIComponent(options.cursor)}`);
    const path = query.length ? `${ZIBBY_APP_FILES_ENDPOINT}?${query.join("&")}` : ZIBBY_APP_FILES_ENDPOINT;
    const response = await request(path, { method: "GET" }, options.signal);
    const body = await readJson(response);
    return {
        items: Array.isArray(body.items)
            ? body.items.filter((row) => row && typeof row === "object").map((row) => fileFrom(row, response.status))
            : [],
        nextCursor: typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null,
        usedBytes: typeof body.used_bytes === "number" ? body.used_bytes : 0,
        quotaBytes: typeof body.quota_bytes === "number" ? body.quota_bytes : ZIBBY_FILES_QUOTA_BYTES,
    };
};
const getFile = async (file, options = {}) => {
    stopIfAborted(options.signal);
    const id = checkedId(file);
    const mock = await mockFiles();
    if (mock) {
        const answer = await mock.get(id, options);
        stopIfAborted(options.signal);
        return answer;
    }
    const response = await request(`${ZIBBY_APP_FILES_ENDPOINT}/${encodeURIComponent(id)}`, { method: "GET" }, options.signal);
    const body = await readJson(response);
    return { file: fileFrom(body.file, response.status), download: downloadFrom(body.download) };
};
const deleteFile = async (file, options = {}) => {
    stopIfAborted(options.signal);
    const id = checkedId(file);
    const mock = await mockFiles();
    if (mock) {
        await mock.remove(id, options);
        stopIfAborted(options.signal);
        return;
    }
    await request(`${ZIBBY_APP_FILES_ENDPOINT}/${encodeURIComponent(id)}`, { method: "DELETE" }, options.signal);
};
const pickFile = async (options = {}) => {
    stopIfAborted(options?.signal);
    if (!validAccept(options.accept))
        return { file: null, reason: "bad_request" };
    const mock = await mockFiles();
    if (mock) {
        const answer = await mock.pick(options);
        stopIfAborted(options.signal);
        return answer;
    }
    return pickOverBridge(options);
};
/**
 * The person's files in this app — recordings, pictures, documents — kept by
 * the platform against the signed-in person and this app.
 *
 * ```ts
 * import { files, ZibbyFilesError } from "@zibby-run/app-kit";
 *
 * const stored = await files.upload(recording, {         // reserve → PUT → complete
 *   name: "Standup.webm",
 *   onProgress: ({ loaded, total }) => setPercent(loaded / total),
 * });
 * const { download } = await files.get(stored.id);       // a 5-minute link
 * const page = await files.list();                       // newest first, ready files only
 * await files.delete(stored.id);
 *
 * const pick = await files.pick({ accept: ["audio/*"] }); // the SHELL's picker
 * if (pick.file) startJob(pick.file.id);
 * else if (pick.reason !== "cancelled") explain(pick.reason);
 * ```
 *
 * **The platform half is live on zibby.run since platform v0.5.0
 * (2026-10-02).** An older platform answers `not_available`. Every call also needs the
 * app's "Stores user files" switch (`file_store_disabled` otherwise).
 *
 * Every refusal is a `ZibbyFilesError` whose `code` the UI switches on; an
 * abort re-throws the browser's own `AbortError`. `pick` never rejects for a
 * person's "no": it resolves `{file: null, reason}`.
 */
export const files = {
    /** Upload one file into this app's folder: reserve, PUT the bytes straight
     *  to storage with exactly the headers the platform signed, then complete.
     *  Resolves with the READY file. */
    upload: uploadFile,
    /** One page of the folder's READY files, newest first, with the usage. */
    list: listFiles,
    /** One file's metadata and a fresh 5-minute download link. Works for this
     *  app's own files AND for a file the person picked for it from another
     *  app (`access: "granted"`). */
    get: getFile,
    /** Delete one of this app's own files (a granted file is `not_found`: it is
     *  another app's). */
    delete: deleteFile,
    /** Ask the Zibby shell to show the person their files — from every app —
     *  and let them choose one for this app. The app never sees the list; it
     *  hears only the answer. A file from another app's folder becomes readable
     *  by this one for 30 days. Before the first pick in a page the kit asks the
     *  files store once (`GET /api/app/files?limit=1`); a platform without it
     *  has no picker, and the pick resolves `unavailable` at once. */
    pick: pickFile,
};
