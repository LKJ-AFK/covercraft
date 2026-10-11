// Background transcription of a recording kept in the app's files
// (CONTRACT.md §15, additive, 0.6.0).
//
//   POST   /api/transcribe/jobs      {file_id, model, language?, duration_s?, action?, known_speakers?}
//                                    → 202 {job}          (x-zibby-request-id: the job id)
//   GET    /api/transcribe/jobs?limit= → {items: [job]}   newest first
//   GET    /api/transcribe/jobs/:id  → {job, result | null}
//   DELETE /api/transcribe/jobs/:id  → {job}  a QUEUED job only; 409 job_running / job_finished
//
// WHY IT EXISTS. `transcribe()` is one request that waits for the whole
// answer, and a long recording's answer can take longer than the platform's
// edge lets a request stay open (Cloudflare closes it at 125 s). A job takes
// a recording ALREADY in the app's files, answers at once, and runs in the
// background for as long as it needs; the app polls it, and while the app is
// open in Zibby the shell also pushes each status change (`zibby:job`).
//
// THE TRANSCRIPT IS A FILE. A succeeded job writes it into the app's folder
// (`kind: "result"`, `<recording>.transcript.json`, kept until deleted), and
// `jobs.get` reads it back in `transcribe()`'s own `TranscribeResult` shape —
// segments with `speaker` included. The recording itself still expires 30
// days after its upload; the job record 30 days after it finished.
//
// MONEY. A job is charged ONCE, when it succeeds, on the same price rule as
// `transcribe()` (the provider's seconds, plus each known speaker's sample
// seconds). A failed or cancelled job charges nothing. At admission the job
// RESERVES the most its file could cost (its bytes at the floor bitrate, at
// most 1,400 s, plus the samples), so `insufficient_credits.needed_cr`
// includes every open job's reservation, and it is never charged more.
//
// NEVER RETRY A POST BY ITSELF. Each POST is a new job; a POST whose answer
// was lost may have made one. `ZibbyJobError.safeToResend` says which
// refusals a PERSON may press "try again" on. Polling (`get`, `await`) is
// always safe.
//
// AVAILABILITY. Live on zibby.run since platform v0.5.0 (2026-10-02); an
// older platform answers `not_available`. Needs the app's "Stores user
// files" switch, and takes only
// `openai/gpt-4o-transcribe-diarize` for now (any other model is
// `400 bad_request`, with a sentence pointing at `transcribe()`).
import { ZIBBY_TRANSCRIBE_JOBS_ENDPOINT } from "./config.js";
export { ZIBBY_TRANSCRIBE_JOBS_ENDPOINT };
import { zibbyFetch } from "./fetch.js";
import { isMockEnabled } from "./client.js";
import { publishBalance } from "./balance.js";
import { noteComped } from "./comped.js";
import { isShellReply } from "./hostBridge.js";
import { fileIdOf, files } from "./files.js";
import { checkKnownSpeakers, encodeKnownSpeakers } from "./knownSpeakers.js";
import { LANGUAGE_MESSAGE, readDurationS, segmentsFrom, toBase64, validAction, validLanguage, } from "./transcribe.js";
/** The one model jobs take today. */
export const ZIBBY_TRANSCRIBE_JOB_MODEL = "openai/gpt-4o-transcribe-diarize";
/** Open (queued or running) jobs one person may have in one app. */
export const ZIBBY_TRANSCRIBE_JOBS_MAX_OPEN = 5;
/** The shell's push for a job's status change. */
export const ZIBBY_JOB_MESSAGE = "zibby:job";
const MESSAGES = {
    bad_request: "That request was not the shape the platform accepts.",
    unknown_model: "This transcription model is not available.",
    unsupported_audio: "That file is not a recording the platform can transcribe.",
    unauthenticated: "Please sign in to transcribe audio.",
    locked: "Your account is on hold — check your Zibby account.",
    insufficient_credits: "Not enough credits.",
    session_cap_reached: "Session spend cap reached.",
    file_store_disabled: "This app is not set up to keep your files.",
    not_found: "That recording or job is no longer there.",
    file_too_large: "That recording is too large to transcribe.",
    too_many_jobs: "Too many transcriptions are already waiting. Try again when one finishes.",
    rate_limited: "Too many requests.",
    job_running: "This transcription has already started and cannot be cancelled.",
    job_finished: "This transcription has already finished.",
    not_configured: "This transcription model is not available right now.",
    storage_unavailable: "File storage is not available right now.",
    not_available: "This feature is not available yet.",
    network: "Could not reach the transcription service.",
    unknown: "Transcription failed.",
};
/** Refused BEFORE a job exists, so sending again costs nobody anything — and
 *  even then a PERSON presses it, never a timer. `network` is not here: a
 *  POST whose answer was lost may have made a job. */
const SAFE_TO_RESEND = new Set([
    "unauthenticated",
    "locked",
    "insufficient_credits",
    "session_cap_reached",
    "too_many_jobs",
    "rate_limited",
    "not_configured",
    "storage_unavailable",
]);
export class ZibbyJobError extends Error {
    constructor(code, message, opts = {}) {
        super(message || MESSAGES[code] || MESSAGES.unknown);
        this.name = "ZibbyJobError";
        this.code = code;
        this.status = opts.status ?? null;
        this.requestId = opts.requestId ?? null;
        this.details = opts.details ?? {};
        this.retryAfterS = opts.retryAfterS ?? null;
        this.safeToResend = SAFE_TO_RESEND.has(code);
    }
}
const badRequest = (message) => new ZibbyJobError("bad_request", message, { details: { error: "bad_request", message } });
const abortError = () => new DOMException("Aborted", "AbortError");
const stopIfAborted = (signal) => {
    if (signal?.aborted)
        throw abortError();
};
let mockLoader = null;
/**   setTranscribeJobsMockLoader(() => import("./myMock").then(m => m.jobsMock));
 *
 *  Consulted only while the one mock flag is on. `null` unregisters it. */
export const setTranscribeJobsMockLoader = (loader) => {
    mockLoader = loader;
};
const mockJobs = async () => isMockEnabled() && mockLoader ? mockLoader() : null;
// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------
const KNOWN_CODES = new Set([
    "bad_request",
    "unknown_model",
    "unsupported_audio",
    "unauthenticated",
    "locked",
    "insufficient_credits",
    "session_cap_reached",
    "file_store_disabled",
    "not_found",
    "file_too_large",
    "too_many_jobs",
    "rate_limited",
    "job_running",
    "job_finished",
    "not_configured",
    "storage_unavailable",
]);
/** For a body that named no code. A bare 404 is an ADDRESS that is not there
 *  (an older platform); the platform itself always names `not_found`. */
const CODE_BY_STATUS = {
    400: "bad_request",
    401: "unauthenticated",
    403: "file_store_disabled",
    404: "not_available",
    413: "file_too_large",
    429: "rate_limited",
    503: "not_configured",
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
    // The platform words a `bad_request` better than a fixed sentence can
    // (which speaker, which limit, which route to use instead).
    const message = code === "bad_request" && typeof body?.message === "string" && body.message
        ? body.message
        : code === "unknown"
            ? `${MESSAGES.unknown} (${response.status}).`
            : MESSAGES[code];
    return new ZibbyJobError(code, message, {
        status: response.status,
        requestId: response.headers.get("x-zibby-request-id"),
        details,
        retryAfterS,
    });
};
/** A 403 here is `file_store_disabled`, which no token mends. */
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
        throw new ZibbyJobError("network");
    }
    if (!response.ok)
        throw await refusalFrom(response);
    return response;
};
const unreadable = (status) => new ZibbyJobError("unknown", "The platform returned an unreadable answer.", { status });
const readJson = async (response) => {
    const body = await bodyOf(response);
    if (!body || typeof body !== "object")
        throw unreadable(response.status);
    return body;
};
const str = (value) => (typeof value === "string" ? value : null);
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
/** A JOB off the wire. A job without an id or a status is not one an app can
 *  wait on, and is refused as unreadable. A status the kit does not know is
 *  passed through — the platform may add one (the contract only grows), and
 *  a 0.6.0 app must keep waiting through it rather than fail. */
export const jobFrom = (raw, status = null) => {
    if (!raw ||
        typeof raw !== "object" ||
        typeof raw.id !== "string" ||
        raw.id === "" ||
        typeof raw.status !== "string" ||
        raw.status === "") {
        throw unreadable(status);
    }
    return {
        id: raw.id,
        status: raw.status,
        model: str(raw.model) ?? "",
        language: str(raw.language),
        fileId: str(raw.file_id),
        resultFileId: str(raw.result_file_id),
        knownSpeakers: Array.isArray(raw.known_speakers)
            ? raw.known_speakers
                .filter((row) => row && typeof row === "object" && typeof row.name === "string")
                .map((row) => ({ name: row.name, durationS: num(row.duration_s) ?? 0, fileId: str(row.file_id) }))
            : [],
        error: raw.error && typeof raw.error === "object" && typeof raw.error.code === "string"
            ? { code: raw.error.code, message: str(raw.error.message) ?? MESSAGES.unknown }
            : null,
        chargedCr: num(raw.charged_cr),
        createdAt: str(raw.created_at) ?? "",
        startedAt: str(raw.started_at),
        finishedAt: str(raw.finished_at),
        // Only the JSON `true` (CONTRACT.md §16); a regular person's job has no
        // `comped` key at all, exactly as before.
        ...(raw.comped === true ? { comped: true } : {}),
    };
};
/** The transcript, in `transcribe()`'s shape, normalised the way
 *  `transcribe()` normalises its own 200 — and the balance it carries is
 *  published, as every charged answer's is. */
export const resultFrom = (raw, job) => {
    if (!raw || typeof raw !== "object")
        return null;
    const balance = num(raw.balance_cr);
    if (balance !== null)
        publishBalance(balance);
    const duration = num(raw.duration_s);
    return {
        text: typeof raw.text === "string" ? raw.text : "",
        language: typeof raw.language === "string" ? raw.language : null,
        duration_s: duration !== null && duration > 0 ? duration : null,
        segments: segmentsFrom(raw.segments),
        charged_cr: num(raw.charged_cr) ?? job.chargedCr ?? 0,
        balance_cr: balance,
        model: typeof raw.model === "string" ? raw.model : job.model,
        requestId: job.id,
        ...(raw.comped === true ? { comped: true } : {}),
    };
};
const jobPath = (id) => `${ZIBBY_TRANSCRIBE_JOBS_ENDPOINT}/${encodeURIComponent(id)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const jobIdOf = (job) => {
    const id = typeof job === "string"
        ? job
        : job && typeof job === "object" && typeof job.id === "string"
            ? job.id
            : null;
    if (id === null || !UUID.test(id))
        throw badRequest("That is not a job id.");
    return id;
};
const isBlob = (value) => typeof Blob !== "undefined" && value instanceof Blob;
const finiteAbove = (value, floor) => typeof value === "number" && Number.isFinite(value) && value > floor ? value : null;
// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------
/**
 * Start a background transcription of one recording and answer the QUEUED
 * job at once. Wait for it with `jobs.await(job.id)`.
 *
 * ```ts
 * const job = await transcribeJob(stored, {            // a ZibbyFile, a file id,
 *   model: "openai/gpt-4o-transcribe-diarize",         // a PickedFile, or a Blob
 *   knownSpeakers: [{ name: "Anna", durationS: 6, file: annaSample }],
 * });
 * const { job: done, result } = await jobs.await(job.id, { onStatus: j => setStatus(j.status) });
 * if (result) render(result.segments);                  // speaker: "Anna" | "B" | …
 * else show(done.error?.message);
 * ```
 *
 * `file` is a recording already in the app's files — its id, or any object
 * with one — or a `Blob`, which is uploaded with `files.upload` first (its
 * refusals are then `ZibbyFilesError`s, and the recording stays in the
 * folder, expiring in 30 days as every recording does).
 *
 * Checked HERE, before anything is uploaded or sent: the model is given, the
 * `language` is two letters, the known speakers follow the platform's rules,
 * and a `Blob` is audio. Each is a `ZibbyJobError` with `status: null`.
 */
export const transcribeJob = async (file, options) => {
    stopIfAborted(options?.signal);
    if (file == null)
        throw badRequest("file_id is required");
    if (typeof options?.model !== "string" || options.model === "") {
        throw badRequest("A transcription model is required.");
    }
    if (options.language != null && !validLanguage(options.language))
        throw badRequest(LANGUAGE_MESSAGE);
    const speakers = checkKnownSpeakers(options.knownSpeakers);
    if (!speakers.ok)
        throw badRequest(speakers.problem.message);
    const action = validAction(options.action) ? options.action : undefined;
    if (options.action !== undefined && action === undefined) {
        console.warn("[zibby] Invalid action label; omitting action:", options.action);
    }
    let fileId;
    let duration = options.durationS === undefined ? null : finiteAbove(options.durationS, 0);
    if (isBlob(file)) {
        const type = (file.type || "").toLowerCase();
        if (!type.startsWith("audio/")) {
            throw new ZibbyJobError("unsupported_audio", undefined, { details: { error: "unsupported_audio" } });
        }
        if (options.durationS === undefined)
            duration = await readDurationS(file, options.signal);
        stopIfAborted(options.signal);
        const stored = await files.upload(file, {
            name: options.name,
            signal: options.signal,
            onProgress: options.onUploadProgress,
        });
        fileId = stored.id;
    }
    else {
        const id = fileIdOf(file);
        if (id === null)
            throw badRequest("file_id is required");
        fileId = id;
    }
    const mock = await mockJobs();
    if (mock) {
        const answer = await mock.create(fileId, options);
        stopIfAborted(options.signal);
        // No `noteComped`: the mock mirrors its own flag onto the page.
        return answer;
    }
    const knownSpeakers = speakers.speakers.length
        ? await encodeKnownSpeakers(speakers.speakers, toBase64)
        : null;
    stopIfAborted(options.signal);
    // Key order is fixed, so a cap retry with the same options is the same
    // body (CONTRACT §5).
    const body = { file_id: fileId, model: options.model };
    if (options.language !== undefined)
        body.language = options.language;
    if (duration !== null)
        body.duration_s = duration;
    if (action !== undefined)
        body.action = action;
    if (knownSpeakers)
        body.known_speakers = knownSpeakers;
    const headers = {};
    if (options.capAck)
        headers["x-zibby-cap-ack"] = "1";
    const response = await request(ZIBBY_TRANSCRIBE_JOBS_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) }, options.signal);
    const created = jobFrom((await readJson(response)).job, response.status);
    // A NEW job's `comped` is the person's standing now, so it says so for the
    // whole page (`getComped()`). It is not charged yet (`chargedCr` null), so
    // it never withdraws it. `jobs.get`/`list`/`await` do neither: a job read
    // back may describe a charge from weeks ago.
    noteComped(created.comped, created.chargedCr);
    return created;
};
const getJob = async (job, options = {}) => {
    stopIfAborted(options.signal);
    const id = jobIdOf(job);
    const mock = await mockJobs();
    if (mock) {
        const answer = await mock.get(id, options);
        stopIfAborted(options.signal);
        return answer;
    }
    const response = await request(jobPath(id), { method: "GET" }, options.signal);
    const body = await readJson(response);
    const parsed = jobFrom(body.job, response.status);
    return { job: parsed, result: parsed.status === "succeeded" ? resultFrom(body.result, parsed) : null };
};
const listJobs = async (options = {}) => {
    stopIfAborted(options.signal);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)) {
        throw badRequest("limit must be 1 to 50");
    }
    const mock = await mockJobs();
    if (mock) {
        const answer = await mock.list(options);
        stopIfAborted(options.signal);
        return answer;
    }
    const path = options.limit === undefined
        ? ZIBBY_TRANSCRIBE_JOBS_ENDPOINT
        : `${ZIBBY_TRANSCRIBE_JOBS_ENDPOINT}?limit=${options.limit}`;
    const response = await request(path, { method: "GET" }, options.signal);
    const body = await readJson(response);
    return Array.isArray(body.items)
        ? body.items.filter((row) => row && typeof row === "object").map((row) => jobFrom(row, response.status))
        : [];
};
const cancelJob = async (job, options = {}) => {
    stopIfAborted(options.signal);
    const id = jobIdOf(job);
    const mock = await mockJobs();
    if (mock) {
        const answer = await mock.cancel(id, options);
        stopIfAborted(options.signal);
        return answer;
    }
    const response = await request(jobPath(id), { method: "DELETE" }, options.signal);
    return jobFrom((await readJson(response)).job, response.status);
};
/** The endings. Any other status — a known one or one a newer platform
 *  added — means the job is still going. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
/** Refusals worth waiting out while a job runs: the job is still there, the
 *  road to it is not. Anything else ends the wait. */
const TRANSIENT = new Set([
    "network",
    "rate_limited",
    "storage_unavailable",
    "not_configured",
]);
/** …and an `unknown` only when it was a server error (a proxy's 502 page).
 *  An unreadable 200 — a status this kit has never heard of, say — is not
 *  going to read better on the next poll, and waiting on it would never end. */
const transient = (error) => TRANSIENT.has(error.code) || (error.code === "unknown" && error.status !== null && error.status >= 500);
/**
 * Wait for a job to finish — `succeeded`, `failed` or `cancelled` — and
 * answer its last state. Any other status, one this kit does not know
 * included, is waited through (and reported to `onStatus`). Resolves for EVERY ending: check `job.status`, and
 * show `job.error.message` on a failure. Rejects only when the job cannot be
 * reached at all (`not_found`, `file_store_disabled`, `unauthenticated`,
 * `locked`, `not_available`), or with an `AbortError`.
 *
 * It polls `jobs.get` every `pollS` seconds (5 by default) and ALSO listens
 * for the shell's `zibby:job` push, which wakes it the moment the status
 * moves while the app is open in Zibby — accepted only from the parent
 * window on the shell's origin. A network blip, a rate limit or a store that
 * did not answer is waited out, not reported: the job runs on the platform
 * whatever this tab does. Stop waiting with `signal`; the job carries on,
 * and `jobs.get` finds it later (for 30 days after it finished).
 */
const awaitJob = async (job, options = {}) => {
    stopIfAborted(options.signal);
    const id = jobIdOf(job);
    const pollMs = Math.max(2, typeof options.pollS === "number" && Number.isFinite(options.pollS) ? options.pollS : 5) * 1000;
    // A push that lands while a poll is in flight is remembered, so the next
    // pause ends at once instead of sleeping through the news.
    let wake = null;
    let nudged = false;
    const nudge = () => {
        const pending = wake;
        wake = null;
        if (pending)
            pending();
        else
            nudged = true;
    };
    const onMessage = (event) => {
        if (!isShellReply(event))
            return;
        const data = event.data;
        if (data?.type === ZIBBY_JOB_MESSAGE && String(data.id) === id)
            nudge();
    };
    const listening = typeof window !== "undefined";
    if (listening)
        window.addEventListener("message", onMessage);
    const mock = await mockJobs();
    const unsubscribe = mock?.subscribe?.(changed => {
        if (changed === id)
            nudge();
    });
    const onAbort = () => nudge();
    options.signal?.addEventListener("abort", onAbort);
    const pause = (ms) => new Promise(resolve => {
        // A rate limit's `retry-after` is honoured even against a push.
        if ((nudged && ms === pollMs) || options.signal?.aborted) {
            nudged = false;
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            wake = null;
            resolve();
        }, ms);
        wake = () => {
            clearTimeout(timer);
            resolve();
        };
    });
    let lastStatus = null;
    try {
        for (;;) {
            stopIfAborted(options.signal);
            let state = null;
            let waitMs = pollMs;
            nudged = false;
            try {
                state = await getJob(id, { signal: options.signal });
            }
            catch (error) {
                if (error?.name === "AbortError")
                    throw error;
                if (!(error instanceof ZibbyJobError) || !transient(error))
                    throw error;
                if (error.retryAfterS !== null)
                    waitMs = Math.max(pollMs, error.retryAfterS * 1000);
            }
            if (state) {
                if (state.job.status !== lastStatus) {
                    lastStatus = state.job.status;
                    try {
                        options.onStatus?.(state.job);
                    }
                    catch {
                        // An app's callback that throws must not end the wait.
                    }
                }
                if (TERMINAL.has(state.job.status))
                    return state;
            }
            await pause(waitMs);
        }
    }
    finally {
        if (listening)
            window.removeEventListener("message", onMessage);
        unsubscribe?.();
        options.signal?.removeEventListener("abort", onAbort);
    }
};
/**
 * The person's transcription jobs in this app.
 *
 *   * `get(id)` — the job and, once it succeeded, its transcript.
 *   * `list({limit})` — newest first, up to 50 (20 by default).
 *   * `cancel(id)` — a QUEUED job only: `job_running` once its call may be
 *     under way, `job_finished` after. Nothing is charged for a cancel.
 *   * `await(id, {signal, onStatus, pollS})` — wait for the ending.
 */
export const jobs = {
    get: getJob,
    list: listJobs,
    cancel: cancelJob,
    await: awaitJob,
};
