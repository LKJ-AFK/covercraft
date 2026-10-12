// The only code in an embedded app that talks to `POST /api/transcribe` —
// the platform's speech-to-text endpoint (CONTRACT.md §8, added 2026-09-17).
//
//   POST /api/transcribe  — same-origin, token-authenticated (`x-csrf-token`)
//     body { model, audio: {data: "<base64>"}, language?, duration_s?, action? }
//   200  {"text", "language", "duration_s", "segments":[{start,end,text}],
//         "charged_cr", "balance_cr", "model"}   + `x-zibby-request-id` header
//        (a segment carries a fourth key, `speaker`, from the one model that
//        labels voices — `openai/gpt-4o-transcribe-diarize`, 2026-09-24)
//        (+ `"comped": true` for a person whose runs are on Zibby — additive,
//        kit 0.7.0, CONTRACT.md §16: then `charged_cr` is 0)
//
// Unlike `/api/ai` this is one plain request with one plain answer — there is
// no stream, so there is no reducer, no terminal frame and no "charge
// unknown" state. `charged_cr` on the 200 IS the ledger's figure (CONTRACT §6),
// and it may be `0`: a free call, or an answer the platform could not put a
// price on. The transcript is delivered either way; that is not an error.
//
// THE ENDPOINT IS NOT IDEMPOTENT. The platform mints the request id at
// admission, so re-sending a request that reached the provider is a second
// provider call and a second charge. Nothing here retries on its own after a
// 502, a 504 or a dropped connection — `ZibbyTranscribeError.safeToResend`
// says which refusals a person may press "try again" on, and a retry a TIMER
// presses is never one of them. (`zibbyFetch`'s one re-ask on 401/403 is safe:
// nothing was admitted.)
//
// What the platform keeps: nothing. No run row, no recording, no transcript.
// Keep what the person needs in the tab, and offer the download while it is
// on screen.
import { ZIBBY_TRANSCRIBE_ENDPOINT } from "./config.js";
import { zibbyFetch } from "./fetch.js";
import { isMockEnabled } from "./client.js";
import { publishBalance } from "./balance.js";
import { noteComped } from "./comped.js";
import { checkKnownSpeakers, encodeKnownSpeakers, inlineSampleBytes, } from "./knownSpeakers.js";
/** The platform's JSON body ceiling on this route. The 413 quotes it back as
 *  `max_bytes`, and it is the number `ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES` is
 *  derived from. */
export const ZIBBY_TRANSCRIBE_BODY_CAP_BYTES = 24000000;
/** Bytes reserved for everything in the body that is not the audio: the model
 *  id, the JSON punctuation, a two-letter language and an action label of up
 *  to 64 characters. Four kilobytes is far more than those can occupy, which
 *  is the point — this is a guard, not a budget. */
const ENVELOPE_RESERVE_BYTES = 4096;
/** The largest file this endpoint can carry: base64 spends 4 characters per 3
 *  bytes, so the audio itself gets three quarters of what is left of the body
 *  cap — about 18 MB, which is roughly what the contract promises. A longer
 *  recording has to be split by the app before it is sent. */
export const ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES = Math.floor(((ZIBBY_TRANSCRIBE_BODY_CAP_BYTES - ENVELOPE_RESERVE_BYTES) * 3) / 4);
/**
 * The transcription models the platform sells, **as of 2026-09-24** — three
 * ids: the two whisper models (2026-09-17) and, since platform v0.4.36
 * (2026-09-24), `openai/gpt-4o-transcribe-diarize`, the one that says WHO
 * spoke. Its segments carry `speaker` (see `TranscribeSegment`), its
 * `language` is always `null`, and it accepts at most
 * `ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS` of audio — past that the platform
 * answers `400 bad_request` with a sentence an app can show as it stands.
 * It is served by OpenAI directly, which reports no cost, so its charge is
 * always this card × the seconds OpenAI measured.
 *
 * The platform is the source of truth: the catalogue lives in its own table
 * and moves without a kit release, so an id you cannot find here is worth
 * asking about rather than unavailable, and a `400 unknown_model` is today's
 * answer whatever this list says. A chat model is `unknown_model` here, and
 * either of these on `/api/ai` is `unknown_model` there — the two catalogues
 * cannot be crossed in either direction.
 */
export const ZIBBY_TRANSCRIPTION_MODELS = [
    { id: "openai/whisper-1", label: "Whisper", usdPerSecond: 0.0001 },
    { id: "openai/whisper-large-v3-turbo", label: "Whisper large v3 turbo", usdPerSecond: 0.00000333 },
    // Added 2026-09-24 (platform v0.4.36). Appended, not inserted: an app that
    // indexed the list by position still finds the two whisper cards where they
    // were.
    { id: "openai/gpt-4o-transcribe-diarize", label: "GPT-4o Transcribe (speakers)", usdPerSecond: 0.0001 },
];
/**
 * The most audio `openai/gpt-4o-transcribe-diarize` accepts: **1400 seconds**
 * (23 min 20 s) — OpenAI's own cap for the model, and the only per-model
 * length cap on the route today. The whisper models have none beyond the
 * ~18 MB byte ceiling.
 *
 * The PLATFORM enforces it, not the kit: a declared `duration_s` past it is
 * refused `400 bad_request` before any provider call, with the message
 * "This model accepts at most 1400 seconds of audio (23 min 20 s). Split the
 * recording and send the parts one at a time." — which `transcribe` puts on
 * `error.message` as it stands. A request that declared no duration (a
 * `MediaRecorder` webm, whose length the browser reads as `Infinity`) is
 * sent, and OpenAI's own refusal comes back as the same `400`, this time
 * with a request id; nothing is charged either way. Pass `durationS` when
 * the app knows the length, so the refusal comes before the upload.
 *
 * Exported so an app can state the limit beside its file input, or split a
 * recording before it sends one, without a number of its own. Say both
 * limits — "up to 23 minutes and 18 MB" — because for a high-bitrate file
 * `ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES` comes first (a 128 kbps mp3 reaches it
 * at about 19 minutes).
 */
export const ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS = 1400;
/** The kit's default English words per code. `bad_request` is the one the
 *  platform can say better than the kit can, so its own `message` wins. */
const MESSAGES = {
    bad_request: "That request was not the shape the platform accepts.",
    unknown_model: "This transcription model is not available.",
    unsupported_audio: "That file is not an audio format the platform accepts.",
    unauthenticated: "Please sign in to transcribe audio.",
    locked: "Your account is on hold — check your Zibby account.",
    insufficient_credits: "Not enough credits.",
    session_cap_reached: "Session spend cap reached.",
    payload_too_large: "That recording is too large to send.",
    rate_limited: "Too many requests.",
    upstream_failed: "The transcription service could not finish this recording.",
    upstream_timeout: "The transcription service took too long to answer.",
    // Since 0.4.2: the realistic `not_configured` is ONE model's route without
    // its key (the speaker model on a deployment with no OpenAI key) while the
    // whisper models still answer — "Transcription is switched off" was false
    // there. This is true of that case and of an operator switching every
    // route off.
    not_configured: "This transcription model is not available right now.",
    network: "Could not reach the transcription service.",
    unknown: "Transcription failed.",
};
/**
 * Which refusals a client may send again, straight from the contract's
 * "Retrying" rules — and the reason the list is short.
 *
 * `401`, `402`, `413`, `429` and `503` are refused BEFORE a request id exists
 * and before any provider is rung, so re-sending them costs nobody anything.
 *
 * `502`, `504` and a dropped connection are the opposite: none of them charge
 * the user, but each may already have been billed to the platform, and a
 * retry loop over them buys the same audio twice. A `400` is a bug in the
 * request, and sending it unchanged only repeats the answer.
 */
const SAFE_TO_RESEND = new Set([
    "unauthenticated",
    // Refused by the same plug, before a request id exists and before any
    // provider is rung — so a re-send costs nobody anything, which is what this
    // set answers. It will fail again until the hold is lifted.
    "locked",
    "insufficient_credits",
    "session_cap_reached",
    "payload_too_large",
    "rate_limited",
    "not_configured",
]);
export class ZibbyTranscribeError extends Error {
    /** `message` is optional: left out (or empty) the code's own English words
     *  are used, so a mock and a hand-built error say what production says. */
    constructor(code, message, opts = {}) {
        super(message || MESSAGES[code] || MESSAGES.unknown);
        this.name = "ZibbyTranscribeError";
        this.code = code;
        this.status = opts.status ?? null;
        this.requestId = opts.requestId ?? null;
        this.details = opts.details ?? {};
        this.retryAfterS = opts.retryAfterS ?? null;
        this.safeToResend = SAFE_TO_RESEND.has(code);
    }
}
/** The app's transcription mock, loaded lazily so a production bundle never
 *  ships it on the critical path — the same shape `setMockLoader` has for
 *  `/api/ai`:
 *
 *    setTranscribeMockLoader(() => import("./myMock").then(m => m.transcribeMock));
 *
 *  Build the mock itself with `createTranscribeMock` from
 *  `@zibby-run/app-kit/mock`. Pass `null` to unregister it. */
let mockLoader = null;
export const setTranscribeMockLoader = (loader) => {
    mockLoader = loader;
};
const finiteAbove = (value, floor) => typeof value === "number" && Number.isFinite(value) && value > floor ? value : null;
const finiteOr = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
/** How long to wait for the browser to read a file's metadata before giving
 *  up and omitting `duration_s`. The figure is an admission hint, not the
 *  charge, so a slow read is never worth a slow button. */
const DURATION_TIMEOUT_MS = 4000;
/** The abort the kit raises itself, shaped exactly like the one a browser's
 *  `fetch` raises — an app catches `error.name === "AbortError"` once and it
 *  is true of every stage. */
const abortError = () => new DOMException("Aborted", "AbortError");
/** Cancel is a state, not a request: every stage asks before it spends
 *  anything, so an aborted call reads no file, encodes no bytes and sends no
 *  request. */
const stopIfAborted = (signal) => {
    if (signal?.aborted)
        throw abortError();
};
/**
 * The recording's length, as the browser reads it — or `null`.
 *
 * `null` is a perfectly good answer and the common one: a webm recorded by
 * `MediaRecorder` reports `Infinity`, a file the browser cannot decode
 * reports nothing at all, and the platform admits a request without the field
 * over its own one-credit floor. What must never happen is `Infinity` or
 * `NaN` reaching the wire, which is `400 bad_request`.
 *
 * An abort ends the probe where it stands — the object URL is revoked, the
 * element is released and the answer is `null` — rather than holding the
 * caller for the rest of `DURATION_TIMEOUT_MS`, which is exactly the wait a
 * codec the browser cannot open would otherwise cost a person who pressed
 * cancel.
 */
export const readDurationS = (file, signal) => {
    if (signal?.aborted ||
        typeof document === "undefined" ||
        typeof URL === "undefined" ||
        typeof URL.createObjectURL !== "function") {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        let url;
        try {
            url = URL.createObjectURL(file);
        }
        catch {
            resolve(null);
            return;
        }
        const audio = document.createElement("audio");
        let timer;
        let settled = false;
        const onAbort = () => finish(null);
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            // THE WHOLE TEARDOWN IS GUARDED, and `resolve` is outside it. Every
            // line below belongs to somebody else's object — a `<audio>` element, a
            // `URL`, an `AbortSignal` — and in a test DOM (`template/` pins
            // happy-dom) media methods are commonly stubs that raise. A throw in
            // here used to mean `resolve` was never reached and never could be:
            // `transcribe()` then waited for ever, with a spinner on screen and no
            // error to show for it. Housekeeping is not worth a call that never
            // ends, so it is done on a best-effort basis and the duration — a hint,
            // not the charge — is handed back either way.
            try {
                if (timer !== undefined)
                    clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                audio.onloadedmetadata = null;
                audio.onerror = null;
                // Clearing the attribute is not enough on its own: an element keeps
                // the resource it already selected, and a browser holding the blob
                // for it ignores the revoke below. `load()` makes it re-select
                // against no source, which is what actually lets an 18 MB recording
                // go. Still guarded by `typeof`, because an element without the
                // method is the ordinary case for a hand-built stub, not an error.
                audio.removeAttribute("src");
                if (typeof audio.load === "function")
                    audio.load();
                URL.revokeObjectURL(url);
            }
            catch {
                // Nothing to do and nobody to tell: the page is about to drop its
                // last reference to the element, and an app cannot act on "this
                // browser's `revokeObjectURL` threw".
            }
            resolve(value);
        };
        audio.preload = "metadata";
        audio.onloadedmetadata = () => finish(finiteAbove(audio.duration, 0));
        audio.onerror = () => finish(null);
        signal?.addEventListener("abort", onAbort);
        timer = setTimeout(() => finish(null), DURATION_TIMEOUT_MS);
        audio.src = url;
    });
};
/** A multiple of 3, so every chunk but the last encodes to unpadded base64
 *  and the pieces concatenate. Small enough that `apply` is an ordinary call:
 *  `String.fromCharCode(...bytes)` over an 18 MB file is not a slow encode,
 *  it is a stack overflow. */
const B64_CHUNK_BYTES = 6144;
export const toBase64 = (bytes) => {
    let out = "";
    for (let offset = 0; offset < bytes.length; offset += B64_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + B64_CHUNK_BYTES);
        out += btoa(String.fromCharCode.apply(null, chunk));
    }
    return out;
};
/** The contract's own rule for an action label, character for character —
 *  including the trailing-newline guard. JavaScript's `$` already means
 *  end-of-input without the `m` flag, so the lookahead is belt to that brace:
 *  it survives an `m` being added, and it survives the pattern being copied
 *  into Elixir, PCRE, Ruby or Python, where `$` also matches immediately
 *  before a final newline and `"label\n"` would pass a check the platform
 *  fails. */
export const validAction = (action) => typeof action === "string" && /^[a-z0-9_:.-]{1,64}$(?![\s\S])/.test(action);
/** The platform's own rule for `language`, character for character: exactly
 *  two letters, after a trim and in either case — it trims and down-cases
 *  before its test, so `" EN "` is as good as `"en"` and travels as written.
 *  The trailing-newline lookahead is the same belt `validAction` wears, for
 *  the same reason: JavaScript's `$` is end-of-input without the `m` flag,
 *  and the lookahead keeps the pattern right if that flag — or a language
 *  whose `$` is looser — ever gets near it. */
export const validLanguage = (language) => typeof language === "string" && /^[a-z]{2}$(?![\s\S])/i.test(language.trim());
/** The platform's own sentence for this refusal, so the words a person reads
 *  are the same whichever side said no. */
export const LANGUAGE_MESSAGE = "language must be a two-letter ISO-639-1 code";
const badLanguage = () => new ZibbyTranscribeError("bad_request", LANGUAGE_MESSAGE, {
    details: { error: "bad_request", message: LANGUAGE_MESSAGE },
});
/** The two refusals a call cannot go on without, worded for a person the way
 *  the platform words its own `bad_request` — the app shows `error.message`,
 *  and `details.message` carries the same sentence a platform refusal would
 *  have put there. */
const badRequest = (message) => new ZibbyTranscribeError("bad_request", message, {
    details: { error: "bad_request", message },
});
const missingFile = () => badRequest("No recording to transcribe.");
const missingModel = () => badRequest("A transcription model is required.");
export const segmentsFrom = (value) => {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== "object")
            continue;
        const text = item.text;
        if (typeof text !== "string")
            continue;
        const segment = {
            start: finiteOr(item.start, 0),
            end: finiteOr(item.end, 0),
            text,
        };
        // The platform's own rule, repeated: a speaker only when it is a
        // non-empty string. The key is ADDED rather than set to `undefined`, so a
        // whisper segment stays exactly three keys — `deepEqual`, a spread into
        // a table row and `Object.keys` in an app all see what they saw on 0.4.1.
        // Only the segment's OWN key counts: a `speaker` something in the page
        // put on `Object.prototype` must not appear on every whisper segment.
        // (`hasOwnProperty.call` rather than `Object.hasOwn`, which is newer than
        // some browsers the kit still runs in.)
        const speaker = Object.prototype.hasOwnProperty.call(item, "speaker")
            ? item.speaker
            : undefined;
        if (typeof speaker === "string" && speaker !== "")
            segment.speaker = speaker;
        out.push(segment);
    }
    return out;
};
const KNOWN_CODES = new Set([
    "bad_request",
    "unknown_model",
    "unsupported_audio",
    "unauthenticated",
    "locked",
    "insufficient_credits",
    "session_cap_reached",
    "payload_too_large",
    "rate_limited",
    "upstream_failed",
    "upstream_timeout",
    "not_configured",
]);
/** The status a body could not name. Every one of these is in the contract's
 *  table, so this is a fallback for a proxy that died before it could write
 *  its body — **not a second opinion**, which is why `errorFromBody` reaches
 *  for it only when the body named no code at all. */
const CODE_BY_STATUS = {
    401: "unauthenticated",
    403: "unauthenticated",
    413: "payload_too_large",
    429: "rate_limited",
    502: "upstream_failed",
    503: "not_configured",
    504: "upstream_timeout",
};
const errorFromBody = (status, requestId, retryAfterS, body) => {
    const named = typeof body?.error === "string" ? body.error : "";
    // The platform's own word beats a guess from the status, ALWAYS: a body
    // that named a code this kit has never heard of is `unknown`, not whichever
    // code shares its status. `403 {"error":"locked"}` used to read as
    // "Please sign in", which is false for somebody who already is.
    const code = KNOWN_CODES.has(named)
        ? named
        : named !== ""
            ? "unknown"
            : CODE_BY_STATUS[status] ?? "unknown";
    const details = body && typeof body === "object" ? { ...body } : {};
    if (retryAfterS !== null)
        details.retry_after_s = retryAfterS;
    // The platform says what was wrong with the request better than a fixed
    // sentence can; every other code has one answer and does not need it.
    const message = code === "bad_request" && typeof body?.message === "string" && body.message
        ? body.message
        : code === "unknown"
            ? `${MESSAGES.unknown} (${status}).`
            : MESSAGES[code];
    return new ZibbyTranscribeError(code, message, { status, requestId, details, retryAfterS });
};
const retryAfterFrom = (response) => {
    const header = response.headers.get("retry-after");
    if (!header)
        return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const tooLarge = (size, maxAudio = ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES) => new ZibbyTranscribeError("payload_too_large", MESSAGES.payload_too_large, {
    details: {
        error: "payload_too_large",
        // `max_bytes` is the platform's key on a 413 and the number an app
        // words its message off, so here it is the limit the person actually
        // hit — the AUDIO ceiling. Quoting the 24 MB body cap would tell
        // somebody "up to 24 MB" about a file refused at about 18. With inline
        // known-speaker samples in the body it is what they left (0.6.0).
        max_bytes: maxAudio,
        // The same figure under its own name …
        max_audio_bytes: maxAudio,
        // … and the platform's body cap under its, for an app that names both.
        body_cap_bytes: ZIBBY_TRANSCRIBE_BODY_CAP_BYTES,
        bytes: size,
    },
});
const settle = (result, requestId) => {
    const balance = finiteOr(result.balance_cr, NaN);
    // Every mounted balance display self-corrects from here, exactly as it does
    // after an `/api/ai` run — and only after an answer that charged.
    if (Number.isFinite(balance))
        publishBalance(balance);
    // Only the JSON `true` (CONTRACT.md §16), from the platform or a mock. The
    // key is left OFF otherwise, so a regular person's result is exactly the
    // object it has always been. (The page-wide value moves on the LIVE path
    // only — see `transcribe` — never on a mock's answer.)
    const { comped, ...rest } = result;
    // `null`, never `0`: a balance nobody sent is unknown, and a UI that shows
    // a person "0 credits" because a field was missing has said something
    // false about their money.
    return {
        ...rest,
        balance_cr: Number.isFinite(balance) ? balance : null,
        requestId,
        ...(comped === true ? { comped: true } : {}),
    };
};
/**
 * Transcribe one recording.
 *
 * ```ts
 * const result = await transcribe(file, { model: "openai/whisper-large-v3-turbo" });
 * result.text;        // the transcript
 * result.segments;    // [{start, end, text}, …] — [] when nothing was timed;
 *                     // + `speaker` on "openai/gpt-4o-transcribe-diarize"
 * result.charged_cr;  // the ledger's figure. MAY BE 0.
 * result.comped;      // true only when this person's runs are on Zibby (0.7.0)
 * ```
 *
 * Takes a `File` or a `Blob` — an `<input type="file">` is the only way in
 * today, because an app iframe has no microphone permission. Nothing about
 * the audio or the transcript is stored, logged or sent to analytics by the
 * kit, and the file's name never leaves the page.
 *
 * Two refusals happen HERE, before the recording is read, because the
 * platform's answer to both is already known: a file over
 * `ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES`, and a `language` that is not exactly
 * two letters. Both carry the typed error the platform would have sent, with
 * `status: null` because nothing was sent.
 *
 * `options.signal` is honoured at every stage — before the file is read,
 * during the duration probe (which is torn down rather than waited out),
 * after the encode and in flight.
 *
 * Rejects with a `ZibbyTranscribeError` whose `code` the UI switches on, or
 * re-throws an `AbortError` when `options.signal` was aborted — the same two
 * shapes `streamZibbyAi` produces. It never retries by itself beyond the one
 * token re-ask on 401/403: see `safeToResend`.
 */
export const transcribe = async (file, options) => {
    // An aborted call is not a call. Before the file is touched, before the
    // mock, before anything: a person who pressed cancel has spent nothing.
    // `options?` because the guards below own the malformed call, and reading
    // `.signal` off nothing would beat them to it with a TypeError; every
    // access after them is on an object those guards have already proved.
    stopIfAborted(options?.signal);
    // Then the two things there is no call without. Both used to be a raw
    // TypeError from somewhere inside — a `size` read off `undefined`, or a
    // body posted with `"model": null` — and a TypeError is not something an
    // app can put on screen or switch on. They are `bad_request` with
    // `status: null`, the shape every refusal the kit makes itself has, and
    // they happen HERE: no duration probe, no encode, no token, no request.
    // Note what this is NOT: a catalogue check. A model id the kit has never
    // heard of is the platform's to refuse, because its list grows without a
    // kit release.
    if (file == null)
        throw missingFile();
    if (typeof options?.model !== "string" || options.model === "")
        throw missingModel();
    // Known speakers (additive, 0.6.0) are checked BEFORE the size, because
    // inline samples ride the same body and take room from the recording.
    // Every refusal here is the platform's own sentence, naming the entry's
    // position and never its name.
    const speakers = checkKnownSpeakers(options.knownSpeakers);
    if (!speakers.ok)
        throw badRequest(speakers.problem.message);
    // Then on `size` alone: reading 18 MB into memory to be told it is 18 MB is
    // the one refusal the browser can spare everybody. With inline samples the
    // ceiling is what the body cap leaves after them (a few MB at most); with
    // none it is `ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES`, exactly as before.
    const sampleBytes = inlineSampleBytes(speakers.speakers);
    const maxAudio = sampleBytes === 0
        ? ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES
        : Math.floor(((ZIBBY_TRANSCRIBE_BODY_CAP_BYTES - ENVELOPE_RESERVE_BYTES - sampleBytes) * 3) / 4);
    if (typeof file?.size === "number" && file.size > maxAudio) {
        throw tooLarge(file.size, maxAudio);
    }
    // And the second one it can spare them. The platform refuses `"en-GB"`,
    // `"eng"` and `"english"` on purpose — guessing which half was meant is how
    // a Portuguese transcript comes back in Spanish — but it refuses them
    // AFTER the whole recording has been uploaded. The kit owns the rule a
    // second time for that reason only, and answers what the platform would.
    if (options.language != null && !validLanguage(options.language)) {
        throw badLanguage();
    }
    if (isMockEnabled() && mockLoader) {
        const mock = await mockLoader();
        const mocked = await mock(file, options);
        return settle(mocked, mocked.requestId ?? null);
    }
    const duration = options.durationS === undefined
        ? await readDurationS(file, options.signal)
        : finiteAbove(options.durationS, 0);
    // The probe answers `null` on an abort rather than throwing, so that one
    // cancel has one shape; this is where it becomes the AbortError.
    stopIfAborted(options.signal);
    const action = validAction(options.action) ? options.action : undefined;
    if (options.action !== undefined && action === undefined) {
        console.warn("[zibby] Invalid action label; omitting action:", options.action);
    }
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    const knownSpeakers = speakers.speakers.length
        ? await encodeKnownSpeakers(speakers.speakers, toBase64)
        : null;
    // Reading and encoding 18 MB takes long enough that a person can press
    // cancel inside it, and an abort after the encode must still cost no
    // request.
    stopIfAborted(options.signal);
    // Key order is the insertion order below, and it is what makes a cap retry
    // byte-identical (CONTRACT §5) when the same file and options come back.
    // `audio.format` is deliberately absent: the contract says it is a hint the
    // platform ignores and never sends on — the first bytes decide.
    const body = { model: options.model, audio: { data } };
    if (options.language !== undefined)
        body.language = options.language;
    if (duration !== null)
        body.duration_s = duration;
    if (action !== undefined)
        body.action = action;
    // Last, and only when there are any: a request without speakers is
    // byte-for-byte the one 0.5.0 sent.
    if (knownSpeakers)
        body.known_speakers = knownSpeakers;
    const headers = {};
    if (options.capAck)
        headers["x-zibby-cap-ack"] = "1";
    let response;
    try {
        response = await zibbyFetch(ZIBBY_TRANSCRIBE_ENDPOINT, {
            method: "POST",
            headers,
            signal: options.signal,
            body: JSON.stringify(body),
        });
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        if (error instanceof ZibbyTranscribeError)
            throw error;
        // Not retried, and deliberately: a connection that dropped may already
        // have reached the provider.
        throw new ZibbyTranscribeError("network", MESSAGES.network);
    }
    const requestId = response.headers.get("x-zibby-request-id");
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw errorFromBody(response.status, requestId, retryAfterFrom(response), body);
    }
    const answer = await response.json().catch(() => null);
    if (!answer || typeof answer !== "object") {
        throw new ZibbyTranscribeError("unknown", "The platform returned an unreadable answer.", {
            status: response.status,
            requestId,
        });
    }
    // Normalised so the TYPE is true of the object and not only of the
    // document: the platform already drops a textless segment and already
    // answers null rather than a figure it could not believe, and this repeats
    // the two so an app never needs a guard of its own.
    const result = settle({
        text: typeof answer.text === "string" ? answer.text : "",
        language: typeof answer.language === "string" ? answer.language : null,
        duration_s: finiteAbove(answer.duration_s, 0),
        segments: segmentsFrom(answer.segments),
        charged_cr: finiteOr(answer.charged_cr, 0),
        balance_cr: finiteOr(answer.balance_cr, NaN),
        model: typeof answer.model === "string" ? answer.model : String(options.model),
        ...(answer.comped === true ? { comped: true } : {}),
    }, requestId);
    // A live answer moves the page-wide value (CONTRACT.md §16): comped sets
    // it, a charge without it withdraws it, a free one says nothing.
    noteComped(result.comped, result.charged_cr);
    return result;
};
