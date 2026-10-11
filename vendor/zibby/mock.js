// The mock ENGINE for `/api/ai` development builds.
//
// Fakes the SSE stream and the terminal `event: zibby` charge event so an
// app's AI actions are clickable without the Elixir proxy running. The engine
// owns everything contract-shaped — the enable/refusal flags, the frame
// replay through `consumeFrame`, the simulated balance — while the app
// supplies what only it can know: the canned answer per action and the quoted
// cost the fake charge is derived from.
//
// An app wires it up in its own lazily-loaded mock module:
//
//   // myMock.ts
//   export const mockStreamZibbyAi = createMockStream({
//     cannedAnswer: request => "...",
//     quoteFor: action => MY_QUOTES[action],
//     // an image app, additive since 2026-09-02:
//     cannedImages: () => [MOCK_IMAGE_DATA_URL],
//   });
//
//   // at startup
//   setMockLoader(() => import("./myMock").then(m => m.mockStreamZibbyAi));
//
// FLIPPING IT
//   on  (build) : ZIBBY_AI_MOCK=1 <build command>
//   on  (any build, at runtime, from devtools):
//                 window.__zibbyAiMock = true
//   refusals    : window.__zibbyAiMock = { fail: "insufficient_credits" }
//                 window.__zibbyAiMock = { fail: "session_cap_reached" }
//                 window.__zibbyAiMock = { fail: "rate_limited" }
//                 window.__zibbyAiMock = { fail: "unknown_model" }
//   off         : delete window.__zibbyAiMock   (and build without ZIBBY_AI_MOCK)
//   comped      : window.__zibbyAiMock = { comped: true }
//                 (additive, 0.7.0, CONTRACT.md §16) — a person whose runs are
//                 on Zibby: every mock below answers as the platform does for
//                 them — `charged_cr: 0`, `comped: true`, the fake balance
//                 untouched — and a `session_cap_reached` carries
//                 `comped: true`. Combine it with `fail` to see a comped
//                 person's cap prompt. Each of those answers mirrors the flag
//                 onto the page (`getComped()`), both ways: set it back to
//                 `true` and the next answer plays a regular person again.
//                 `installMockHostBridge` plays a comped viewer from install
//                 when the flag already says so, and clears it on teardown.
//
// `createTranscribeMock` (bottom of this file) rides the SAME flag and the
// same fake balance — two switches would be a production build that draws a
// free answer through the one somebody forgot — and reads the same `fail`
// field for its own refusals: `bad_request`, `unknown_model`,
// `unsupported_audio`, `unauthenticated`, `insufficient_credits`,
// `session_cap_reached`, `payload_too_large`, `rate_limited`,
// `upstream_failed`, `upstream_timeout`, `not_configured`, `network` and
// `unknown` (additive 2026-09-18 — the two the browser itself raises, so a
// dead network and an unreadable answer are clickable offline), and
// `unpriced` — which is not a refusal at all but the 200 that charged
// nothing. Handed `openai/gpt-4o-transcribe-diarize` (additive, 2026-09-24)
// it answers the way that model does — segments with a `speaker`, a `null`
// language — and refuses a recording past the model's 1400-second cap with
// the platform's own `400 bad_request` sentence, no flag needed.
//
// The `/api/ai` mock above deliberately has no `network` and no `unknown`:
// there, `network` is TWO different sentences — "Could not reach the AI
// service." before the stream and "The connection to the AI service dropped
// mid-answer." inside it — and one `fail` name would have to pick one and
// teach an app the wrong half. `transcribe` is one request with one answer,
// so its `network` has one shape.
//
// `createAppDataMock` (below it, 2026-09-18) rides the same flag again, for
// the same reason, and reads the same `fail` field for `data_store_disabled`,
// `not_available` (a platform that predates the store — older than v0.4.35),
// `locked`, `rate_limited`, `unauthenticated`, `bad_request`, `invalid_key`,
// `not_found`, `quota_exceeded` and `document_too_large`. A `fail` value that
// means nothing to a given mock is ignored by it, so one flag can be set for
// whichever mock a person is looking at.
//
// `createFilesMock` and `createTranscribeJobsMock` (at the bottom, additive
// 0.6.0) ride the same flag once more: an in-memory folder with the shell's
// picker, and jobs that go queued → running → succeeded on timers, with
// their own `fail` values listed where each is defined.
//
// OFF IS THE DEFAULT.
import { consumeFrame, isMockEnabled, ZibbyAiError, } from "./client.js";
import { installHostBridge, ZIBBY_CSRF_MESSAGE, ZIBBY_TRACK_MESSAGE, ZIBBY_ERROR_MESSAGE, } from "./hostBridge.js";
import { ZibbyTranscribeError, ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS, ZIBBY_TRANSCRIPTION_MODELS, } from "./transcribe.js";
import { isAppDataName, ZibbyAppDataError, ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES, ZIBBY_APP_DATA_MAX_LIST_LIMIT, } from "./appData.js";
import { setMockAppUserId } from "./appUser.js";
import { setMockComped } from "./comped.js";
import { ZibbyFilesError, ZIBBY_FILES_AUDIO_RETENTION_DAYS, ZIBBY_FILES_DOWNLOAD_TTL_S, ZIBBY_FILES_MAX_AUDIO_BYTES, } from "./files.js";
import { ZibbyJobError, ZIBBY_TRANSCRIBE_JOB_MODEL, ZIBBY_TRANSCRIBE_JOBS_MAX_OPEN, } from "./transcribeJobs.js";
/** Start a standalone local-dev bridge with a console-only mock shell.
 *  Use instead of installHostBridge in dev; never impersonate an embedded shell. */
export const installMockHostBridge = (options = {}) => {
    if (typeof window === "undefined" || window.parent !== window)
        return () => { };
    const onMessage = (event) => {
        if (event.origin !== window.location.origin || event.source !== window)
            return;
        if (event.data?.type === ZIBBY_TRACK_MESSAGE || event.data?.type === ZIBBY_ERROR_MESSAGE) {
            console.log(`[zibby mock] ${event.data.type}`, event.data);
        }
    };
    window.addEventListener("message", onMessage);
    const stopBridge = installHostBridge(options);
    window.postMessage({ type: ZIBBY_CSRF_MESSAGE, token: null }, window.location.origin);
    // A development page in mock mode gets a mock identity too, off the SAME
    // flag — no second switch, no global of its own, nothing in storage. It is
    // kept apart from the bridge's own value (`setMockAppUserId`), so the
    // anonymous handshake above cannot wipe it and a real shell always wins.
    if (isMockEnabled())
        setMockAppUserId(MOCK_APP_USER_ID);
    // …and, with `{ comped: true }` on the same flag (0.7.0), a viewer whose
    // runs are on Zibby — kept apart from the bridge's own value for the same
    // reason, so the anonymous handshake above cannot withdraw it.
    if (isMockEnabled() && mockComped())
        setMockComped(true);
    return () => {
        stopBridge();
        window.removeEventListener("message", onMessage);
        // The comped viewer goes with the bridge that played it.
        setMockComped(false);
    };
};
const DEFAULT_START_BALANCE = 250;
/** A whole 1×1 PNG as a data URL — what the mock hands back for a generated
 *  image, and what an app's `cannedImages` should return unless it has
 *  placeholder art of its own. Real bytes on purpose: an `<img>` bound to this
 *  renders, so the download button and the gallery layout are exercised
 *  offline rather than first in production. */
export const MOCK_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const mockConfig = () => {
    if (typeof window === "undefined")
        return {};
    const flag = window.__zibbyAiMock;
    return flag && typeof flag === "object" ? flag : {};
};
/** `window.__zibbyAiMock = { comped: true }` — the mocks answer as the
 *  platform does for a person whose runs are on Zibby. Only the JSON `true`,
 *  as on the wire. Read at the moment each call answers, like `fail`. */
const mockComped = () => mockConfig().comped === true;
/** Every money mock answer MIRRORS the flag onto the page (`getComped()`),
 *  both ways: setting `{ comped: true }` from devtools plays a comped viewer
 *  from the next answer, and setting it back plays a regular one again. A
 *  mock's answer is never treated as the person's standing, so it cannot
 *  outlive the flag. */
const mirrorMockComped = () => {
    const comped = mockComped();
    setMockComped(comped);
    return comped;
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Build a mock stream that re-encodes the canned answer as the exact frames
 *  the real proxy emits and pushes them through the same reducer `client.ts`
 *  uses for a live stream.
 *
 *  Text-only Anthropic runs end with message_delta.delta.stop_reason
 *  (end_turn / max_tokens). OpenAI runs use choices[0].delta.content, with
 *  finish_reason null until the last content frame (stop / length).
 *  stopReasonFor(request) overrides the static stopReason for that run;
 *  undefined falls back to the static value, then end_turn. Image runs
 *  emit no stop reason.
 *
 *  Returns the STRICT result (`images` always an array), which is why an app
 *  built on this engine never sees an optional. `MockStream` — the type
 *  `setMockLoader` accepts — is looser on purpose, so a hand-written mock
 *  that predates images still compiles. */
export const createMockStream = (config) => {
    return async (request, options = {}) => {
        const { fail } = mockConfig();
        mirrorMockComped();
        const requestId = `mock-${Date.now().toString(36)}`;
        const win = typeof window === "undefined" ? {} : window;
        if (typeof win.__zibbyMockBalance !== "number") {
            win.__zibbyMockBalance = config.startBalance ?? DEFAULT_START_BALANCE;
        }
        await sleep(120);
        if (fail === "insufficient_credits") {
            throw new ZibbyAiError("insufficient_credits", "Not enough credits.", {
                status: 402,
                requestId,
                details: { error: "insufficient_credits", balance_cr: 1 },
            });
        }
        if (fail === "session_cap_reached" && !options.capAck) {
            throw new ZibbyAiError("session_cap_reached", "Session spend cap reached.", {
                status: 402,
                requestId,
                // The cap applies to a comped person too, and their refusal says so.
                details: {
                    error: "session_cap_reached",
                    spent_cr: 200,
                    cap_cr: 200,
                    ...(mockComped() ? { comped: true } : {}),
                },
            });
        }
        if (fail === "rate_limited") {
            throw new ZibbyAiError("rate_limited", "Too many requests.", {
                status: 429,
                requestId,
                details: { error: "rate_limited" },
            });
        }
        if (fail === "unknown_model") {
            throw new ZibbyAiError("unknown_model", "This model is not available.", {
                status: 400,
                requestId,
                details: { error: "unknown_model" },
            });
        }
        const answer = config.cannedAnswer(request);
        const images = config.cannedImages?.(request) ?? [];
        const openai = request.provider === "openai";
        const stopReason = images.length ? null : config.stopReasonFor?.(request) ?? config.stopReason ?? "end_turn";
        const state = { text: "", stopReason: null, terminal: null, images: [] };
        // Chunk the way a model does: a few tokens at a time, not all at once.
        const pieces = answer.match(/[\s\S]{1,24}/g) ?? [];
        // Even an empty OpenAI text answer needs a final completion chunk.
        if (openai && !images.length && !pieces.length)
            pieces.push("");
        for (const [index, piece] of pieces.entries()) {
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            consumeFrame({
                event: openai ? null : "content_block_delta",
                data: JSON.stringify(openai ? {
                    choices: [{
                            index: 0,
                            delta: { content: piece },
                            finish_reason: stopReason !== null && index === pieces.length - 1
                                ? (stopReason === "max_tokens" ? "length" : "stop") : null,
                        }],
                } : {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: piece },
                }),
            }, options.onDelta, state);
            await sleep(16);
        }
        // The pictures, in the wire shape the proxy forwards verbatim
        // (`choices[].delta.images[].image_url.url`), after the text and before
        // the terminal frame — which is the order a real image stream arrives in.
        for (const url of images) {
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            consumeFrame({
                event: null,
                data: JSON.stringify({
                    id: "chatcmpl-mock",
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: { images: [{ type: "image_url", index: 0, image_url: { url } }] },
                        },
                    ],
                }),
            }, options.onDelta, state);
            await sleep(16);
        }
        if (!openai && stopReason !== null) {
            consumeFrame({
                event: "message_delta",
                data: JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: stopReason },
                }),
            }, options.onDelta, state);
        }
        // The quote is an estimate; the real proxy charges what the tokens cost.
        // A comped person (0.7.0) is charged nothing and their own balance does
        // not move: the platform books the run on Zibby's pool, and says so with
        // `comped: true` — which goes through the same reducer as everything else.
        const comped = mockComped();
        const charged = comped ? 0 : config.quoteFor(request.action) + 1;
        win.__zibbyMockBalance = Math.max(0, win.__zibbyMockBalance - charged);
        consumeFrame({
            event: "zibby",
            data: JSON.stringify({
                charged_cr: charged,
                balance_cr: win.__zibbyMockBalance,
                model: request.model,
                ...(comped ? { comped: true } : {}),
            }),
        }, options.onDelta, state);
        return {
            text: state.text,
            model: state.model ?? null,
            stopReason: state.stopReason ?? null,
            images: state.images ?? [],
            terminal: state.terminal,
            requestId,
        };
    };
};
// ---------------------------------------------------------------------------
// Speech to text — the mock for `transcribe` (CONTRACT.md §8).
//
//   // myMock.ts
//   export const transcribeMock = createTranscribeMock();
//
//   // at startup, beside setMockLoader
//   setTranscribeMockLoader(() => import("./myMock").then(m => m.transcribeMock));
//
// It answers a canned transcript with timed segments, a duration derived from
// the file's size, a charge derived from the model's price card, and a fake
// balance that goes down — the same `window.__zibbyMockBalance` the `/api/ai`
// mock spends, so one dev session has one balance.
// ---------------------------------------------------------------------------
/** What a voice memo costs in bytes per second: an m4a from a phone lands
 *  near 8,000–16,000, a browser's webm/Opus near 3,000–6,000. The mock takes
 *  the top of that range so a small test file still reads as several seconds. */
const MOCK_BYTES_PER_SECOND = 16000;
/** The mock's own arithmetic, NOT a promise about the platform's: seconds ×
 *  the model's card × the margin, rounded up to whole credits. That is the
 *  platform's FALLBACK, not its rule — in production the charge is built on
 *  the cost the provider itself reported, with this figure as the estimate
 *  and the bound (CONTRACT §8, "The price rule"), so a dev number and a live
 *  one will differ. The live margin is the app creator's (a price multiplier
 *  the Zibby team may set per creator, else the platform's own), it moves
 *  without a kit release, and the only figure an app may ever show as a
 *  charge is `charged_cr` off the answer (CONTRACT §6). These two live here,
 *  in the mock, for that reason. */
const MOCK_MARGIN = 1.3;
const MOCK_CREDITS_PER_USD = 100;
const MOCK_TRANSCRIPT = "Reminder to self: pick up the keys before six. " +
    "The spare set is in the blue drawer under the window. " +
    "Call back about the quote on Thursday morning.";
/** The word each provider answers with — `openai/whisper-1`'s shape. Turbo
 *  answers the two-letter code instead, and both are the provider's own
 *  (CONTRACT §8), so an app that renders `result.language` straight into the
 *  page has to meet ITS model's shape in dev, not one shape for both. */
const LANGUAGE_WORDS = {
    en: "english", fr: "french", de: "german", es: "spanish", it: "italian",
    pt: "portuguese", nl: "dutch", ru: "russian", uk: "ukrainian", pl: "polish",
    tr: "turkish", ja: "japanese", ko: "korean", zh: "chinese", ar: "arabic",
};
const round1 = (seconds) => Math.round(seconds * 10) / 10;
/** Sentences where there are sentences, three roughly equal runs of words
 *  where there are not. No lookbehind: the published bundle has to parse in
 *  every browser the kit supports, and a mock module that throws a
 *  SyntaxError takes the whole chunk with it. */
const sentences = (text) => {
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const parts = (trimmed.match(/[^.!?…]+[.!?…]*\s*/g) ?? [])
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length > 1)
        return parts;
    const words = trimmed.split(/\s+/);
    if (words.length < 3)
        return [trimmed];
    const size = Math.ceil(words.length / 3);
    const chunks = [];
    for (let index = 0; index < words.length; index += size) {
        chunks.push(words.slice(index, index + size).join(" "));
    }
    return chunks;
};
/** The voices the mock hands out, in turn, when the model labels them —
 *  OpenAI's own shape (`"A"`, `"B"`, …). Two, alternating, so a transcript of
 *  three sentences shows an app both a change of voice and a return to one it
 *  has already drawn. */
const MOCK_SPEAKERS = ["A", "B"];
const mockSegments = (text, total, speakers, names = []) => {
    const pieces = sentences(text);
    if (!pieces.length)
        return [];
    // Known speakers' names first, in turn, then OpenAI's letters — so a list
    // of one name shows an app both a named voice and an unnamed one.
    const voices = names.length ? [...names, "B"].slice(0, Math.max(2, names.length)) : MOCK_SPEAKERS;
    const step = total / pieces.length;
    let start = 0;
    return pieces.map((piece, index) => {
        const end = index === pieces.length - 1 ? total : round1(step * (index + 1));
        // Added, never set to `undefined`: a whisper segment is exactly the
        // three keys the real client hands back for it.
        const segment = { start, end, text: piece };
        if (speakers)
            segment.speaker = voices[index % voices.length];
        start = end;
        return segment;
    });
};
/** The platform's sentence for a recording past a model's cap
 *  (`Zibby.Transcribe.too_long_message/1`), word for word, so the refusal a
 *  designer lays out in dev is the one production shows. */
const tooLongMessage = (maxSeconds) => `This model accepts at most ${maxSeconds} seconds of audio ` +
    `(${Math.floor(maxSeconds / 60)} min ${maxSeconds % 60} s). ` +
    "Split the recording and send the parts one at a time.";
const tooLong = (maxSeconds, requestId) => {
    const message = tooLongMessage(maxSeconds);
    return new ZibbyTranscribeError("bad_request", message, {
        status: 400,
        requestId,
        details: { error: "bad_request", message },
    });
};
const mockRefusal = (code, requestId, capAck) => {
    const refuse = (status, details, message, extra = {}) => new ZibbyTranscribeError(code, message, {
        status,
        // The platform mints a request id at admission, so only the two
        // refusals that reached a provider carry one. Mirrored here, because an
        // app that renders "ref: {requestId}" unconditionally should see the
        // null in dev rather than in production.
        requestId: extra.requestId ?? null,
        retryAfterS: extra.retryAfterS ?? null,
        details: { error: code, ...details },
    });
    switch (code) {
        case "bad_request":
            return refuse(400, { message: 'language must be exactly two letters, like "en"' }, 'language must be exactly two letters, like "en"');
        case "unknown_model":
        case "unsupported_audio":
            return refuse(400, {});
        case "unauthenticated":
            return refuse(401, {});
        case "insufficient_credits":
            return refuse(402, { balance_cr: 1, needed_cr: 8 });
        case "session_cap_reached":
            // The one refusal a client ACTS on: ask, then send the identical
            // request again with `capAck`. The mock lets that second one through.
            // A comped person's refusal says so (0.7.0); the cap still applies.
            return capAck
                ? null
                : refuse(402, { spent_cr: 200, cap_cr: 200, ...(mockComped() ? { comped: true } : {}) });
        case "payload_too_large":
            return refuse(413, { max_bytes: 24000000 });
        case "rate_limited":
            return refuse(429, { retry_after_s: 60 }, undefined, { retryAfterS: 60 });
        case "not_configured":
            return refuse(503, {});
        case "upstream_failed":
            return refuse(502, {}, undefined, { requestId });
        case "upstream_timeout":
            return refuse(504, {}, undefined, { requestId });
        // The two the BROWSER produces rather than the platform. Built by hand,
        // not through `refuse`, because each has to be the object `transcribe`
        // itself throws, field for field — and the two differ exactly where the
        // real paths differ. `network` is a request that got no answer at all:
        // no status, no request id, nothing in `details`. `unknown` is the
        // opposite — a 200 ARRIVED, charged, and could not be read (`transcribe`
        // raises it with `status: response.status` and the id off the header), so
        // the mock's carries the 200 and the request id it minted. Neither is
        // `safeToResend`: a call that may have reached a provider is never a Try
        // again the kit offers.
        case "network":
            return new ZibbyTranscribeError(code);
        case "unknown":
            return new ZibbyTranscribeError(code, "The platform returned an unreadable answer.", {
                status: 200,
                requestId,
            });
        default:
            return null;
    }
};
/**
 * Build a transcription mock: a canned transcript, timed segments, a charge
 * and a balance, with no network call of any kind.
 *
 * The default message for a refusal is the kit's own — `ZibbyTranscribeError`
 * fills it in from the code — so the words a designer reads in dev are the
 * words production will show.
 */
export const createTranscribeMock = (config = {}) => {
    return async (file, options) => {
        const { fail } = mockConfig();
        mirrorMockComped();
        const requestId = `mock-${Date.now().toString(36)}`;
        const win = typeof window === "undefined" ? {} : window;
        if (typeof win.__zibbyMockBalance !== "number") {
            win.__zibbyMockBalance = config.startBalance ?? DEFAULT_START_BALANCE;
        }
        const stopIfAborted = () => {
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
        };
        stopIfAborted();
        // A transcription is one wait, not a stream: one beat — the same 120 ms
        // the AI mock spends before its first frame — and then the whole answer.
        await sleep(120);
        stopIfAborted();
        if (typeof fail === "string") {
            const refusal = mockRefusal(fail, requestId, options.capAck);
            if (refusal)
                throw refusal;
        }
        const perSecond = config.bytesPerSecond ?? MOCK_BYTES_PER_SECOND;
        const text = config.cannedText?.(file, options) ?? MOCK_TRANSCRIPT;
        const pieces = Math.max(1, sentences(text).length);
        // The price card, and — since 2026-09-18 — the model whose ANSWER is
        // being imitated. An id this kit has never heard of falls back to turbo
        // here, so the seconds and the language below fall back with it rather
        // than disagreeing with the price.
        const card = ZIBBY_TRANSCRIPTION_MODELS.find(model => model.id === options.model) ??
            ZIBBY_TRANSCRIPTION_MODELS[1];
        const isWhisper1 = card.id === "openai/whisper-1";
        const isDiarize = card.id === "openai/gpt-4o-transcribe-diarize";
        // Known speakers (additive, 0.6.0): the diarize model only, as on the
        // platform, with the platform's own sentence for any other model. The
        // shape rules already ran in `transcribe()` before the mock was asked.
        const known = (options.knownSpeakers ?? []).map(speaker => ({
            name: String(speaker.name).trim(),
            seconds: Math.min(10, Math.max(2, Number(speaker.durationS) || 0)),
        }));
        if (known.length && !isDiarize) {
            const message = `known_speakers is accepted only by openai/gpt-4o-transcribe-diarize, not by ${String(options.model)}`;
            throw new ZibbyTranscribeError("bad_request", message, {
                status: 400,
                details: { error: "bad_request", message },
            });
        }
        // At least a tenth of a second per segment, so two of them can never
        // share a boundary and a duration is never zero.
        const measured = Math.max(round1((file.size || 0) / perSecond), round1(pieces * 0.1));
        // The seconds the PROVIDER reports, and the two do not report alike:
        // `openai/whisper-1` answers whole seconds rounded UP — 27 for a
        // 26.1-second clip — and the platform bills on that figure, while turbo
        // answers fractional ones (CONTRACT §8). The charge below is built on
        // whichever this is, which is the point: a dev page showing "N credits"
        // beside a duration does the arithmetic production will do.
        const duration = isWhisper1 ? Math.ceil(measured) : measured;
        // The diarize model's 1400-second cap, refused the two ways the platform
        // refuses it. A DECLARED `durationS` past the cap is refused at admission
        // — before a request id exists, so none is on the error. A recording
        // with no declared length is sent, and the provider's own refusal comes
        // back as the same `400` carrying the request id admission minted; the
        // mock never runs the browser's duration probe, so here that is any call
        // without a usable `durationS` whose size-derived length is past the cap.
        // Nothing is charged either way, so the fake balance is untouched. (At
        // the default 16,000 bytes a second that second case needs a file over
        // the kit's own ~18 MB ceiling; set `bytesPerSecond` lower, or pass
        // `durationS`, to draw it.)
        if (isDiarize) {
            // "Declared" the way `transcribe` declares: a finite number above
            // zero, and anything else is left off the request.
            const declared = typeof options.durationS === "number" &&
                Number.isFinite(options.durationS) &&
                options.durationS > 0
                ? options.durationS
                : null;
            if (declared !== null && declared > ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS) {
                throw tooLong(ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS, null);
            }
            if (declared === null && duration > ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS) {
                throw tooLong(ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS, requestId);
            }
        }
        // Trimmed and down-cased exactly as the platform does before its own
        // two-letter test, so `" EN "` and `"en"` are one language here too.
        const languageCode = options.language ? options.language.trim().toLowerCase() : "en";
        // `unpriced` is not a refusal: it is the 200 the platform answers when it
        // could not put a price on what came back. The transcript arrives, the
        // charge is nought, and an app that says "Charged {n} credits" without
        // looking has to see it once.
        // The samples' seconds are billed on top of the recording's (0.6.0).
        const sampleSeconds = known.reduce((total, speaker) => total + speaker.seconds, 0);
        // A comped person (0.7.0) is charged nothing and their balance does not
        // move; the answer says `comped: true`, as the platform's does.
        const comped = mockComped();
        const charged = fail === "unpriced" || comped
            ? 0
            : Math.ceil((duration + sampleSeconds) * card.usdPerSecond * MOCK_MARGIN * MOCK_CREDITS_PER_USD);
        win.__zibbyMockBalance = Math.max(0, win.__zibbyMockBalance - charged);
        return {
            text,
            // Whichever shape this model's provider answers in: the word for
            // whisper-1, the two-letter code for turbo, and the code as given when
            // it is one the word list does not carry. Named or detected, the shape
            // is the model's (CONTRACT §8). The diarize model answers none at all:
            // its speaker-labelled answer carries no language, even one it was told.
            language: isDiarize
                ? null
                : isWhisper1
                    ? LANGUAGE_WORDS[languageCode] ?? "english"
                    : languageCode,
            duration_s: duration,
            segments: mockSegments(text, duration, isDiarize, known.map(speaker => speaker.name)),
            charged_cr: charged,
            balance_cr: win.__zibbyMockBalance,
            model: String(options.model),
            requestId,
            // Added only when true, so a regular person's answer is exactly the
            // object it always was.
            ...(comped ? { comped: true } : {}),
        };
    };
};
// ---------------------------------------------------------------------------
// App data — the mock store for `appData` (CONTRACT.md §12).
//
//   // myMock.ts
//   export const appDataMock = createAppDataMock({
//     seed: { resumes: { "cv-2026": { title: "Senior engineer" } } },
//   });
//
//   // at startup, beside setMockLoader
//   setAppDataMockLoader(() => import("./myMock").then(m => m.appDataMock));
//
// IT DOES NOT SURVIVE A RELOAD, and that is a decision rather than an
// omission. The real store does survive one, so a mock that forgets is a
// worse design tool — but the only way to make a browser one remember is a
// storage key, and the kit's own promise is that no document value, key or
// collection name ever reaches `localStorage` or `IndexedDB`. A mock that
// broke that promise would break it in exactly the builds a developer is
// looking at, and the invariant would then be true only of a build nobody
// inspects. `seed` is the better answer anyway: a dev page comes up with the
// SAME documents every time, so a screenshot is reproducible and yesterday's
// half-finished shape cannot haunt today's layout.
//
// Its quotas are deliberately small — the point of a mock quota is to be hit
// while somebody is watching — and every one of them is configurable, so an
// app that wants to rehearse against the platform's real ceilings can.
// ---------------------------------------------------------------------------
/** The dev identity, in the platform's own grammar (`u_` + 26 lower-case
 *  base32 characters) so that an app which asserts the shape of an id passes
 *  in development too — and readable enough that nobody mistakes it for a real
 *  one. */
export const MOCK_APP_USER_ID = "u_mockmockmockmockmockmockmo";
/** Small on purpose: 25 documents and 50 kB are enough for any dev page and
 *  few enough that a "you have run out of room" screen can be reached in a
 *  minute. The platform's own are 1,000 and 5,000,000. */
const MOCK_QUOTA_DOCS = 25;
const MOCK_QUOTA_BYTES = 50000;
/** The platform's own per-page value budget. Unreachable under the mock's
 *  default byte quota, and correct as soon as somebody raises it. */
const MOCK_PAGE_VALUE_BYTES = 1000000;
/** The platform's default page size. */
const MOCK_LIST_LIMIT = 50;
const mockBytes = (value) => new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
/** ISO 8601 with a `Z` and MICROseconds, which is the shape the platform
 *  sends — `toISOString()` alone stops at milliseconds, and an app that
 *  formats or compares these strings should meet the real one in dev. */
const mockStamp = (ms) => new Date(ms).toISOString().replace(/Z$/, "000Z");
const mockCursor = (seq) => `c${seq}`;
const mockRefuse = (code, status, details = {}, retryAfterS = null) => new ZibbyAppDataError(code, undefined, {
    status,
    details: { error: code, ...details },
    retryAfterS,
});
/**
 * An in-memory `/api/app/data`: the same grammar, the same versions and
 * conflicts, the same newest-created-first listing with a cursor that holds,
 * quotas that can be hit, and the `data_store_disabled` state of an app whose
 * operator never switched the store on.
 *
 * It makes no network call of any kind and keeps nothing in browser storage.
 * Building one while the mock is enabled (`isMockEnabled()`, the same one
 * flag) also hands this dev build a fake `u_mock…` identity, so
 * `getAppUserId()` and `useAppUser()` answer something. With the flag off it
 * hands over nothing at all — the store is inert and so is the identity.
 */
export const createAppDataMock = (config = {}) => {
    const quotaDocs = config.quotaDocs ?? MOCK_QUOTA_DOCS;
    const quotaBytes = config.quotaBytes ?? MOCK_QUOTA_BYTES;
    const maxDocumentBytes = config.maxDocumentBytes ?? ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES;
    const latency = config.latencyMs ?? 60;
    const clock = config.now ?? (() => Date.now());
    // The dev identity, the moment the store exists — and only while the mock
    // is enabled, exactly as `installMockHostBridge` gates the identical call.
    // A build that merely IMPORTS this module must not find itself signed in as
    // `u_mock…` with the flag off, which is the state the mock STORE correctly
    // stays inert in. Kept apart from the bridge's own value, so a real shell
    // always wins and a signed-out handshake cannot wipe it.
    if (isMockEnabled())
        setMockAppUserId(config.appUserId ?? MOCK_APP_USER_ID);
    const data = new Map();
    let seq = 0;
    const rowsOf = (collection) => {
        const existing = data.get(collection);
        if (existing)
            return existing;
        const made = new Map();
        data.set(collection, made);
        return made;
    };
    const write = (collection, key, value, version, at) => {
        const rows = rowsOf(collection);
        const previous = rows.get(key);
        rows.set(key, {
            value,
            version,
            bytes: mockBytes(value),
            updatedAt: mockStamp(at),
            seq: previous ? previous.seq : (seq += 1),
        });
    };
    for (const [collection, documents] of Object.entries(config.seed ?? {})) {
        for (const [key, value] of Object.entries(documents)) {
            write(collection, key, value, 1, clock());
        }
    }
    const totals = () => {
        let usedDocs = 0;
        let usedBytes = 0;
        for (const rows of data.values()) {
            for (const row of rows.values()) {
                usedDocs += 1;
                usedBytes += row.bytes;
            }
        }
        return { usedDocs, usedBytes };
    };
    const quotaRefusal = () => {
        const { usedDocs, usedBytes } = totals();
        return mockRefuse("quota_exceeded", 413, {
            used_bytes: usedBytes,
            quota_bytes: quotaBytes,
            used_docs: usedDocs,
            quota_docs: quotaDocs,
        });
    };
    /** The refusals a person can ask for from devtools, off the SAME flag the
     *  other two mocks read. A `fail` that belongs to another mock is not one of
     *  ours and is ignored. */
    const flagged = () => {
        const { fail } = mockConfig();
        switch (fail) {
            case "data_store_disabled":
                return mockRefuse("data_store_disabled", 403);
            case "unauthenticated":
                return mockRefuse("unauthenticated", 401);
            case "rate_limited":
                return mockRefuse("rate_limited", 429, { retry_after_s: 60 }, 60);
            case "bad_request":
                return mockRefuse("bad_request", 400);
            case "invalid_key":
                return mockRefuse("invalid_key", 400);
            case "not_found":
                return mockRefuse("not_found", 404);
            // A platform older than v0.4.35, which predates the store: no such
            // address, on every call. Every app has to degrade through it.
            case "not_available":
                return mockRefuse("not_available", 404);
            // The account is on hold. Not the app's doing, and not mendable by it.
            case "locked":
                return mockRefuse("locked", 403);
            case "document_too_large":
                return mockRefuse("document_too_large", 413, { max_bytes: maxDocumentBytes });
            case "quota_exceeded":
                return quotaRefusal();
            default:
                return null;
        }
    };
    const stop = (options) => {
        if (options.signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
    };
    /** One beat, then the answer — and the flag is read AFTER it, at the moment
     *  the real platform would have answered, so a refusal set from devtools
     *  while a call is in flight is the one that lands. */
    const begin = async (options) => {
        stop(options);
        if (latency)
            await sleep(latency);
        stop(options);
        const refusal = flagged();
        if (refusal)
            throw refusal;
    };
    const name = (value) => {
        if (!isAppDataName(value))
            throw mockRefuse("invalid_key", 400);
    };
    return {
        async usage(options) {
            await begin(options);
            const collections = [...data.entries()]
                .map(([collection, rows]) => ({
                name: collection,
                count: rows.size,
                bytes: [...rows.values()].reduce((sum, row) => sum + row.bytes, 0),
            }))
                // A collection with nothing left in it is not in the list at all (N7).
                .filter(row => row.count > 0)
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            const { usedDocs, usedBytes } = totals();
            return { collections, usedBytes, quotaBytes, usedDocs, quotaDocs };
        },
        async clear(options) {
            await begin(options);
            data.clear();
        },
        async get(collection, key, options) {
            await begin(options);
            name(collection);
            name(key);
            const row = data.get(collection)?.get(key);
            if (!row)
                return null;
            return { key, value: row.value, version: row.version, updatedAt: row.updatedAt };
        },
        async put(collection, key, value, options) {
            await begin(options);
            name(collection);
            name(key);
            const previous = data.get(collection)?.get(key);
            if (options.ifVersion !== undefined) {
                // A version named for a document that is not there is `not_found`:
                // the thing the caller believed they were replacing is gone.
                if (!previous)
                    throw mockRefuse("not_found", 404);
                if (previous.version !== options.ifVersion) {
                    throw mockRefuse("version_conflict", 409, { current_version: previous.version });
                }
            }
            const bytes = mockBytes(value);
            if (bytes > maxDocumentBytes) {
                throw mockRefuse("document_too_large", 413, { max_bytes: maxDocumentBytes, bytes });
            }
            const { usedDocs, usedBytes } = totals();
            // An overwrite counts the DIFFERENCE, and does not move the count.
            const nextDocs = usedDocs + (previous ? 0 : 1);
            const nextBytes = usedBytes - (previous ? previous.bytes : 0) + bytes;
            if (nextDocs > quotaDocs || nextBytes > quotaBytes)
                throw quotaRefusal();
            const version = previous ? previous.version + 1 : 1;
            const at = clock();
            write(collection, key, value, version, at);
            return { key, version, updatedAt: mockStamp(at) };
        },
        async remove(collection, key, options) {
            await begin(options);
            name(collection);
            name(key);
            // Idempotent: the postcondition is that it is GONE, and it is gone in
            // both cases (S1). A name outside the grammar is still refused above —
            // idempotent is not "accepts anything".
            data.get(collection)?.delete(key);
        },
        async list(collection, options) {
            await begin(options);
            name(collection);
            const prefix = options.prefix ?? "";
            if (typeof prefix !== "string" || !/^[a-z0-9_.-]{0,64}$(?![\s\S])/.test(prefix)) {
                throw mockRefuse("bad_request", 400);
            }
            const limit = options.limit ?? MOCK_LIST_LIMIT;
            if (!Number.isInteger(limit) || limit < 1 || limit > ZIBBY_APP_DATA_MAX_LIST_LIMIT) {
                throw mockRefuse("bad_request", 400);
            }
            let after = Infinity;
            if (options.cursor !== undefined) {
                // Opaque to a caller, and a forged or truncated one is a refusal — it
                // is not a capability and cannot widen a scope.
                const match = /^c([0-9]+)$(?![\s\S])/.exec(options.cursor);
                if (!match)
                    throw mockRefuse("bad_request", 400);
                after = Number(match[1]);
            }
            const ordered = [...(data.get(collection)?.entries() ?? [])]
                .filter(([key, row]) => key.startsWith(prefix) && row.seq < after)
                // Newest CREATED first, never most-recently-updated: a document
                // written in January and edited this morning still lists where
                // January put it, and that is what makes the cursor hold.
                .sort((a, b) => b[1].seq - a[1].seq);
            const items = [];
            let valueBytes = 0;
            let last = 0;
            for (const [key, row] of ordered) {
                if (items.length >= limit)
                    break;
                // The page's own value budget, which always hands back at least one
                // document so a listing cannot stall.
                if (options.values && items.length > 0 && valueBytes + row.bytes > MOCK_PAGE_VALUE_BYTES) {
                    break;
                }
                const item = {
                    key,
                    version: row.version,
                    bytes: row.bytes,
                    updatedAt: row.updatedAt,
                };
                if (options.values) {
                    item.value = row.value;
                    valueBytes += row.bytes;
                }
                items.push(item);
                last = row.seq;
            }
            const more = ordered.length > items.length;
            return { items, nextCursor: more && last ? mockCursor(last) : null };
        },
    };
};
// ---------------------------------------------------------------------------
// Files — the mock folder for `files` (CONTRACT.md §14, additive 0.6.0).
//
//   // myMock.ts
//   export const filesMock = createFilesMock({
//     seed: [{ name: "Standup.webm", contentType: "audio/webm", bytes: 480_000 }],
//   });
//   export const jobsMock = createTranscribeJobsMock({ files: filesMock });
//
//   // at startup, beside the other loaders
//   setFilesMockLoader(() => import("./myMock").then(m => m.filesMock));
//   setTranscribeJobsMockLoader(() => import("./myMock").then(m => m.jobsMock));
//
// An in-memory folder: uploads land in it (with progress), `list` pages it
// newest first, `get` hands out a link to the bytes (an object URL, so an
// `<audio src>` plays in dev), `delete` removes, and `pick` answers the way
// the shell's picker does — the newest ready file that matches `accept`, or
// a canned recording "from another app" (`access: "granted"`) when the
// folder has none. Like the app-data mock it does not survive a reload and
// keeps nothing in browser storage.
//
// Its `fail` values, off the same `window.__zibbyAiMock` flag:
// `file_store_disabled` (every call, and the pick), `not_available` (every
// call; the pick answers `unavailable`), `unauthenticated`, `locked`,
// `rate_limited`, `storage_unavailable`, `quota_exceeded`, `too_many_files`,
// `unsupported_type`, `upload_failed` (the storage PUT), and the pick-only
// `cancelled`, `throttled`, `busy`, `signed_out`, `not_running`,
// `unavailable`, `interrupted`.
// ---------------------------------------------------------------------------
/** A tiny, silent, valid WAV — what the canned picked recording holds, so a
 *  dev page that plays the picked file plays something rather than erroring. */
const silentWav = () => {
    const samples = 800; // 0.1 s at 8 kHz, 8-bit mono
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1)
            view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    ascii(36, "data");
    view.setUint32(40, samples, true);
    for (let i = 0; i < samples; i += 1)
        view.setUint8(44 + i, 128);
    return new Blob([buffer], { type: "audio/wav" });
};
const PICK_ONLY_REASONS = new Set([
    "cancelled",
    "throttled",
    "busy",
    "signed_out",
    "not_running",
    "unavailable",
    "interrupted",
]);
const mockUuid = (seq) => {
    const hex = seq.toString(16).padStart(12, "0").slice(-12);
    return `00000000-0000-4000-8000-${hex}`;
};
const acceptsType = (accept, type) => !accept ||
    accept.some(entry => {
        const want = entry.trim().toLowerCase();
        if (want === "*/*")
            return true;
        if (want.endsWith("/*"))
            return type.startsWith(want.slice(0, -1));
        return type === want;
    });
/**
 * An in-memory `/api/app/files` plus the shell's picker: the same shapes,
 * limits that can be hit, the 30-day expiry stamped on audio, and every
 * refusal a person can ask for from devtools. No network call of any kind.
 */
export const createFilesMock = (config = {}) => {
    const quotaBytes = config.quotaBytes ?? 50 * 1024 * 1024;
    const maxFiles = config.maxFiles ?? 25;
    const latency = config.latencyMs ?? 60;
    const clock = config.now ?? (() => Date.now());
    let seq = 0;
    const own = new Map();
    const granted = new Map();
    const stamp = (ms) => mockStamp(ms);
    const make = (seed, access) => {
        seq += 1;
        const at = clock();
        const type = seed.contentType.split(";")[0].trim().toLowerCase();
        const audio = type.startsWith("audio/");
        const blob = seed.blob ?? (audio ? silentWav() : new Blob([], { type }));
        const file = {
            id: mockUuid(seq),
            name: seed.name,
            contentType: type,
            bytes: seed.bytes ?? (seed.blob ? seed.blob.size : 1024),
            kind: seed.kind ?? "upload",
            purpose: audio ? "audio" : "other",
            status: "ready",
            createdAt: stamp(at),
            completedAt: stamp(at),
            expiresAt: audio ? stamp(at + ZIBBY_FILES_AUDIO_RETENTION_DAYS * 86400000) : null,
        };
        if (access)
            file.access = access;
        return { file, blob, url: null };
    };
    const add = (seed) => {
        const entry = make(seed);
        own.set(entry.file.id, entry);
        return entry.file;
    };
    for (const seed of config.seed ?? [])
        add(seed);
    const usedBytes = () => [...own.values()].reduce((sum, entry) => sum + entry.file.bytes, 0);
    const refuse = (code, status, details = {}, retryAfterS = null) => new ZibbyFilesError(code, undefined, { status, details: { error: code, ...details }, retryAfterS });
    const flagged = () => {
        const { fail } = mockConfig();
        switch (fail) {
            case "file_store_disabled":
                return refuse("file_store_disabled", 403);
            case "not_available":
                return refuse("not_available", 404);
            case "unauthenticated":
                return refuse("unauthenticated", 401);
            case "locked":
                return refuse("locked", 403);
            case "rate_limited":
                return refuse("rate_limited", 429, { retry_after_s: 60 }, 60);
            case "storage_unavailable":
                return refuse("storage_unavailable", 503);
            default:
                return null;
        }
    };
    const begin = async (options) => {
        if (options.signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
        if (latency)
            await sleep(latency);
        if (options.signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
        const refusal = flagged();
        if (refusal)
            throw refusal;
    };
    const linkOf = (entry) => {
        if (!entry.url) {
            try {
                entry.url = typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
                    ? URL.createObjectURL(entry.blob)
                    : `data:${entry.file.contentType},`;
            }
            catch {
                entry.url = `data:${entry.file.contentType},`;
            }
        }
        return { url: entry.url, expiresAt: stamp(clock() + ZIBBY_FILES_DOWNLOAD_TTL_S * 1000) };
    };
    const newestFirst = () => [...own.values()].map(entry => entry.file).reverse();
    return {
        addFile: add,
        peek(id) {
            const entry = own.get(id) ?? granted.get(id);
            return entry ? { file: entry.file, blob: entry.blob } : null;
        },
        async upload(file, meta, options) {
            await begin(options);
            const { fail } = mockConfig();
            if (fail === "unsupported_type")
                throw refuse("unsupported_type", 415);
            if (fail === "quota_exceeded" || usedBytes() + file.size > quotaBytes) {
                throw refuse("quota_exceeded", 413, { used_bytes: usedBytes(), quota_bytes: quotaBytes });
            }
            if (fail === "too_many_files" || own.size >= maxFiles) {
                throw refuse("too_many_files", 413, { max_files: maxFiles });
            }
            // The bytes "go up" in two beats, so a progress bar is seen to move.
            options.onProgress?.({ loaded: Math.floor(file.size / 2), total: file.size });
            if (latency)
                await sleep(latency);
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            if (fail === "upload_failed") {
                throw new ZibbyFilesError("upload_failed", undefined, {
                    status: 403,
                    details: { error: "upload_failed", upload_status: 403 },
                });
            }
            options.onProgress?.({ loaded: file.size, total: file.size });
            return add({ name: meta.name, contentType: meta.contentType, bytes: file.size, blob: file });
        },
        async list(options) {
            await begin(options);
            const limit = options.limit ?? 50;
            const ordered = newestFirst();
            let start = 0;
            if (options.cursor !== undefined) {
                const match = /^f([0-9]+)$(?![\s\S])/.exec(options.cursor);
                if (!match)
                    throw refuse("bad_request", 400);
                start = Number(match[1]);
            }
            const items = ordered.slice(start, start + limit);
            const next = start + limit < ordered.length ? `f${start + limit}` : null;
            return { items, nextCursor: next, usedBytes: usedBytes(), quotaBytes };
        },
        async get(id, options) {
            await begin(options);
            const entry = own.get(id) ?? granted.get(id);
            if (!entry)
                throw refuse("not_found", 404);
            const file = { ...entry.file, access: own.has(id) ? "own" : "granted" };
            return { file, download: linkOf(entry) };
        },
        async remove(id, options) {
            await begin(options);
            const entry = own.get(id);
            // A granted file is another app's: this app cannot delete it.
            if (!entry)
                throw refuse("not_found", 404);
            own.delete(id);
            if (entry.url?.startsWith("blob:")) {
                try {
                    URL.revokeObjectURL(entry.url);
                }
                catch {
                    // Nothing to release.
                }
            }
        },
        async pick(options) {
            const { fail } = mockConfig();
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            if (latency)
                await sleep(latency);
            if (options.signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            if (fail === "file_store_disabled")
                return { file: null, reason: "file_store_disabled" };
            if (fail === "not_available")
                return { file: null, reason: "unavailable" };
            if (typeof fail === "string" && PICK_ONLY_REASONS.has(fail))
                return { file: null, reason: fail };
            const folder = newestFirst();
            let chosen = config.pickAnswer
                ? config.pickAnswer(options, folder)
                : folder.find(file => acceptsType(options.accept, file.contentType)) ?? null;
            if (typeof chosen === "string")
                return { file: null, reason: chosen };
            if (!chosen) {
                // Nothing of the app's own fits: a recording "from another app", as
                // a person with other apps would see in the real picker.
                const type = options.accept?.find(entry => !entry.includes("*")) ?? "audio/wav";
                if (!acceptsType(options.accept, type.startsWith("audio/") ? type : "audio/wav")) {
                    return { file: null, reason: "cancelled" };
                }
                const entry = make({ name: "Recording from another app.wav", contentType: "audio/wav" }, "granted");
                entry.file.bytes = entry.blob.size;
                granted.set(entry.file.id, entry);
                chosen = entry.file;
            }
            return {
                file: { id: chosen.id, name: chosen.name, contentType: chosen.contentType, bytes: chosen.bytes },
                reason: null,
            };
        },
    };
};
const JOB_FAILURES = {
    file_gone: "The recording was deleted before the transcription ran.",
    access_revoked: "The recording's owner stopped sharing it with this app.",
    known_speaker_gone: "A known speaker's sample was deleted before the transcription ran.",
    upstream_failed: "The transcription service could not finish this recording.",
    upstream_timeout: "The transcription service took too long to answer.",
    quota_exceeded: "The transcript did not fit in this app's files.",
    interrupted: "The transcription was interrupted. Nothing was charged; start it again.",
};
const jobRefusal = (code, capAck) => {
    const refuse = (status, details = {}, message, retryAfterS) => new ZibbyJobError(code, message, { status, details: { error: code, ...details }, retryAfterS: retryAfterS ?? null });
    switch (code) {
        case "bad_request":
            return refuse(400, { message: "file_id is required" }, "file_id is required");
        case "unknown_model":
        case "unsupported_audio":
            return refuse(400);
        case "unauthenticated":
            return refuse(401);
        case "insufficient_credits":
            return refuse(402, { balance_cr: 1, needed_cr: 8 });
        case "session_cap_reached":
            return capAck
                ? null
                : refuse(402, { spent_cr: 200, cap_cr: 200, ...(mockComped() ? { comped: true } : {}) });
        case "file_store_disabled":
            return refuse(403);
        case "not_found":
            return refuse(404);
        case "not_available":
            return refuse(404, {});
        case "file_too_large":
            return refuse(413, { max_bytes: ZIBBY_FILES_MAX_AUDIO_BYTES });
        case "too_many_jobs":
            return refuse(429, { max_jobs: ZIBBY_TRANSCRIBE_JOBS_MAX_OPEN });
        case "rate_limited":
            return refuse(429, { retry_after_s: 60 }, undefined, 60);
        case "not_configured":
        case "storage_unavailable":
            return refuse(503);
        default:
            return null;
    }
};
/**
 * An in-memory `/api/transcribe/jobs`: admission with its refusals, the
 * five-open-jobs limit, the timed lifecycle with a push on every change,
 * cancel's conflicts, a charge on success only, and the transcript in the
 * files mock's folder. No network call of any kind.
 */
export const createTranscribeJobsMock = (config = {}) => {
    const queuedMs = config.queuedMs ?? 800;
    const runningMs = config.runningMs ?? 2500;
    const latency = config.latencyMs ?? 60;
    const clock = config.now ?? (() => Date.now());
    const win = typeof window === "undefined" ? {} : window;
    const table = new Map();
    const listeners = new Set();
    let seq = 0;
    const notify = (job) => {
        for (const listener of [...listeners]) {
            try {
                listener(job.id, job.status);
            }
            catch {
                // A listener that throws must not stop the others.
            }
        }
    };
    const beat = async (signal) => {
        if (signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
        if (latency)
            await sleep(latency);
        if (signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
    };
    const flaggedAdmission = (options) => {
        const { fail } = mockConfig();
        return typeof fail === "string" ? jobRefusal(fail, options.capAck) : null;
    };
    const flaggedRead = () => {
        const { fail } = mockConfig();
        switch (fail) {
            case "file_store_disabled":
            case "unauthenticated":
            case "not_available":
            case "rate_limited":
                return jobRefusal(fail, false);
            default:
                return null;
        }
    };
    const finish = (entry, options, fileBytes) => {
        const job = entry.job;
        if (job.status !== "running")
            return;
        const at = mockStamp(clock());
        if (entry.failWith) {
            job.status = "failed";
            job.error = { code: entry.failWith, message: JOB_FAILURES[entry.failWith] ?? "Transcription failed." };
            job.finishedAt = at;
            notify(job);
            return;
        }
        const text = config.cannedText?.(job.fileId ?? "", options) ?? MOCK_TRANSCRIPT;
        const duration = round1(typeof options.durationS === "number" && Number.isFinite(options.durationS) && options.durationS > 0
            ? options.durationS
            : Math.max(1, fileBytes / MOCK_BYTES_PER_SECOND));
        const names = job.knownSpeakers.map(speaker => speaker.name);
        const samples = job.knownSpeakers.reduce((total, speaker) => total + Math.min(10, Math.max(2, speaker.durationS)), 0);
        const card = ZIBBY_TRANSCRIPTION_MODELS[2];
        // A job made for a comped person (0.7.0) is charged nothing, and its
        // result says so, as the platform's does.
        const charged = job.comped
            ? 0
            : Math.ceil((duration + samples) * card.usdPerSecond * MOCK_MARGIN * MOCK_CREDITS_PER_USD);
        if (typeof win.__zibbyMockBalance !== "number")
            win.__zibbyMockBalance = config.startBalance ?? DEFAULT_START_BALANCE;
        win.__zibbyMockBalance = Math.max(0, win.__zibbyMockBalance - charged);
        const segments = mockSegments(text, duration, true, names);
        if (config.files) {
            const source = job.fileId ? config.files.peek(job.fileId) : null;
            const base = (source?.file.name ?? "Recording").replace(/\.[^.]*$/, "");
            const transcript = JSON.stringify({ job_id: job.id, source_file_id: job.fileId, model: job.model, text, language: null, duration_s: duration, segments });
            const stored = config.files.addFile({
                name: `${base}.transcript.json`,
                contentType: "application/json",
                blob: new Blob([transcript], { type: "application/json" }),
                kind: "result",
            });
            job.resultFileId = stored.id;
        }
        job.status = "succeeded";
        job.chargedCr = charged;
        job.finishedAt = at;
        entry.result = {
            text,
            language: null,
            duration_s: duration,
            segments,
            charged_cr: charged,
            balance_cr: win.__zibbyMockBalance,
            model: job.model,
            requestId: job.id,
            ...(job.comped ? { comped: true } : {}),
        };
        notify(job);
    };
    const later = (ms, run) => {
        setTimeout(run, ms);
    };
    const copy = (job) => ({
        ...job,
        knownSpeakers: job.knownSpeakers.map(speaker => ({ ...speaker })),
        error: job.error ? { ...job.error } : null,
    });
    return {
        async create(fileId, options) {
            await beat(options.signal);
            mirrorMockComped();
            const refusal = flaggedAdmission(options);
            if (refusal)
                throw refusal;
            if (options.model !== ZIBBY_TRANSCRIBE_JOB_MODEL) {
                const message = `background jobs take ${ZIBBY_TRANSCRIBE_JOB_MODEL} only for now; send ${String(options.model)} to POST /api/transcribe`;
                throw new ZibbyJobError("bad_request", message, { status: 400, details: { error: "bad_request", message } });
            }
            let fileBytes = 0;
            if (config.files) {
                const source = config.files.peek(fileId);
                if (!source)
                    throw jobRefusal("not_found", false);
                if (source.file.purpose !== "audio")
                    throw jobRefusal("unsupported_audio", false);
                fileBytes = source.file.bytes;
            }
            const open = [...table.values()].filter(entry => entry.job.status === "queued" || entry.job.status === "running");
            if (open.length >= ZIBBY_TRANSCRIBE_JOBS_MAX_OPEN)
                throw jobRefusal("too_many_jobs", false);
            seq += 1;
            const { fail } = mockConfig();
            const job = {
                id: `00000000-0000-4000-9000-${seq.toString(16).padStart(12, "0").slice(-12)}`,
                status: "queued",
                model: String(options.model),
                language: options.language ? options.language.trim().toLowerCase() : null,
                fileId,
                resultFileId: null,
                knownSpeakers: (options.knownSpeakers ?? []).map(speaker => ({
                    name: String(speaker.name).trim(),
                    durationS: Number(speaker.durationS),
                    fileId: typeof speaker.file === "string" ? speaker.file : speaker.file && !(speaker.file instanceof Blob) ? speaker.file.id : null,
                })),
                error: null,
                chargedCr: null,
                createdAt: mockStamp(clock()),
                startedAt: null,
                finishedAt: null,
                // From the moment the job exists, as on the platform (0.7.0).
                ...(mockComped() ? { comped: true } : {}),
            };
            const entry = {
                job,
                result: null,
                failWith: typeof fail === "string" && fail in JOB_FAILURES ? fail : null,
            };
            table.set(job.id, entry);
            later(queuedMs, () => {
                if (job.status !== "queued")
                    return;
                job.status = "running";
                job.startedAt = mockStamp(clock());
                notify(job);
                later(runningMs, () => finish(entry, options, fileBytes));
            });
            return copy(job);
        },
        async get(id, options) {
            await beat(options.signal);
            const refusal = flaggedRead();
            if (refusal)
                throw refusal;
            const entry = table.get(id);
            if (!entry)
                throw jobRefusal("not_found", false);
            // A result whose transcript file the app deleted reads as null, as it
            // does on the platform.
            const gone = config.files && entry.job.resultFileId && !config.files.peek(entry.job.resultFileId);
            return { job: copy(entry.job), result: entry.result && !gone ? { ...entry.result } : null };
        },
        async list(options) {
            await beat(options.signal);
            const refusal = flaggedRead();
            if (refusal)
                throw refusal;
            return [...table.values()].map(entry => copy(entry.job)).reverse().slice(0, options.limit ?? 20);
        },
        async cancel(id, options) {
            await beat(options.signal);
            const refusal = flaggedRead();
            if (refusal)
                throw refusal;
            const entry = table.get(id);
            if (!entry)
                throw jobRefusal("not_found", false);
            if (entry.job.status === "running")
                throw new ZibbyJobError("job_running", undefined, { status: 409, details: { error: "job_running" } });
            if (entry.job.status !== "queued")
                throw new ZibbyJobError("job_finished", undefined, { status: 409, details: { error: "job_finished" } });
            entry.job.status = "cancelled";
            entry.job.finishedAt = mockStamp(clock());
            notify(entry.job);
            return copy(entry.job);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};
