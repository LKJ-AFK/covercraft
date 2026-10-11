// The only code in an embedded app that talks to `/api/ai`.
//
// Implements the frozen contract v0 (CONTRACT.md in this repo) and nothing
// else:
//
//   POST /api/ai  — same-origin, token-authenticated (`x-csrf-token` header)
//     body { provider, model, stream: true, payload: <provider-native body> }
//   200 -> SSE: provider events verbatim, then one terminal
//               `event: zibby` / `data: {"charged_cr":int,"balance_cr":int}`
//               (+ `"comped": true` for a person whose runs are on Zibby —
//               additive, kit 0.7.0, CONTRACT.md §16: then `charged_cr` is 0)
//
// Additive since 2026-09-02 (CONTRACT.md §2, "Images"): an OpenAI-format
// stream from an image model also carries `choices[].delta.images[]`, each an
// `image_url.url` holding a data URL. They are collected onto
// `ZibbyResult.images` in stream order. The platform's 15-minute pickup shelf
// is temporary (CONTRACT.md §11); offer "download now" while output is in hand.
//   413 {"error":"payload_too_large","max_bytes":int}
//   402 {"error":"insufficient_credits","balance_cr":int}
//   402 {"error":"session_cap_reached","spent_cr":int,"cap_cr":int}
//       (+ "comped":true for a person whose runs are on Zibby, kit 0.7.0)
//       -> retry the SAME request with header `x-zibby-cap-ack: 1`
//   429 {"error":"rate_limited"}
//   400 {"error":"unknown_model"}
//   403 {"error":"locked"}  — the person's account is on hold. The token is
//       fine, so this is the one 401/403 that is NEITHER re-asked NOR re-sent.
//
// The response also carries `x-zibby-request-id`; surface it in errors so a
// support question can be matched to a ledger row.
import { ZIBBY_AI_ENDPOINT } from "./config.js";
import { readCsrfToken, requestFreshToken } from "./hostBridge.js";
import { zibbyFetch } from "./fetch.js";
import { noteComped } from "./comped.js";
export class ZibbyAiError extends Error {
    constructor(code, message, opts = {}) {
        super(message);
        this.name = "ZibbyAiError";
        this.code = code;
        this.status = opts.status ?? null;
        this.requestId = opts.requestId ?? null;
        this.details = opts.details ?? {};
    }
}
/** The app's mock, loaded lazily so a production bundle never ships it on the
 *  critical path. The app registers a thunk once at startup:
 *
 *    setMockLoader(() => import("./myMock").then(m => m.mockStreamZibbyAi));
 *
 *  Build the mock itself with `createMockStream` from `@zibby-run/app-kit/mock`. */
let mockLoader = null;
export const setMockLoader = (loader) => {
    mockLoader = loader;
};
/** Build-time flag (`ZIBBY_AI_MOCK=1` at build) or a runtime escape hatch
 *  (`window.__zibbyAiMock = true`, or an object such as
 *  `{ fail: "insufficient_credits" }`, set from devtools). A runtime
 *  `window.__zibbyAiMock = false` also *disables* a mock-on build. */
export const isMockEnabled = () => {
    const runtime = typeof window === "undefined" ? undefined : window.__zibbyAiMock;
    if (runtime !== undefined)
        return Boolean(runtime);
    try {
        if (typeof process === "undefined")
            return false;
        return process.env?.NEXT_PUBLIC_ZIBBY_AI_MOCK === "1";
    }
    catch {
        return false;
    }
};
/** Pull the human-readable text out of one provider SSE frame.
 *  Anthropic Messages: `content_block_delta` → `delta.text`.
 *  OpenAI Chat Completions: `choices[].delta.content`. */
const providerDelta = (data) => {
    if (!data || typeof data !== "object")
        return "";
    // Anthropic
    if (data.type === "content_block_delta") {
        const delta = data.delta;
        if (typeof delta?.text === "string")
            return delta.text;
        if (typeof delta?.partial_json === "string")
            return delta.partial_json;
    }
    // OpenAI
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice && typeof choice.delta?.content === "string")
        return choice.delta.content;
    return "";
};
/** Read the provider's own stop reason without normalizing its values. */
const providerStopReason = (data) => {
    if (!data || typeof data !== "object")
        return null;
    if (data.type === "message_delta" && typeof data.delta?.stop_reason === "string") {
        return data.delta.stop_reason;
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    return typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
};
const createStreamState = () => ({
    text: "", model: null, stopReason: null, terminal: null, images: [],
});
const streamOutcome = (state, requestId) => ({
    text: state.text,
    model: state.model ?? null,
    stopReason: state.stopReason ?? null,
    images: state.images ?? [],
    terminal: state.terminal,
    chargeKnown: state.terminal !== null,
    requestId,
});
/** Split a raw SSE buffer into complete frames, returning the unconsumed tail. */
const takeFrames = (buffer) => {
    const frames = [];
    let rest = buffer.replace(/\r\n/g, "\n");
    for (;;) {
        const boundary = rest.indexOf("\n\n");
        if (boundary === -1)
            break;
        const raw = rest.slice(0, boundary);
        rest = rest.slice(boundary + 2);
        let event = null;
        const dataLines = [];
        for (const line of raw.split("\n")) {
            if (line.startsWith(":"))
                continue; // comment / keep-alive
            if (line.startsWith("event:"))
                event = line.slice(6).trim();
            else if (line.startsWith("data:"))
                dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length || event)
            frames.push({ event, data: dataLines.join("\n") });
    }
    return { frames, rest };
};
/** Pull generated images out of one provider SSE frame.
 *  OpenAI Chat Completions: `choices[].delta.images[].image_url.url`.
 *  Anthropic has no equivalent today and yields nothing. */
const providerImages = (data) => {
    if (!data || !Array.isArray(data.choices))
        return [];
    const urls = [];
    for (const choice of data.choices) {
        const images = choice?.delta?.images;
        if (!Array.isArray(images))
            continue;
        for (const image of images) {
            const url = image?.image_url?.url;
            if (typeof url === "string" && url)
                urls.push(url);
        }
    }
    return urls;
};
/** Feed one frame into the accumulating result. Exported for the mock engine,
 *  which replays byte-identical frames through the same reducer. */
export const consumeFrame = (frame, onDelta, state) => {
    if (frame.data === "[DONE]")
        return;
    let parsed;
    try {
        parsed = JSON.parse(frame.data);
    }
    catch {
        return; // a provider may emit non-JSON keep-alives; ignore rather than fail
    }
    if (frame.event === "zibby") {
        state.model = typeof parsed?.model === "string" ? parsed.model : null;
        state.terminal = {
            charged_cr: Number(parsed?.charged_cr ?? 0),
            balance_cr: Number(parsed?.balance_cr ?? 0),
        };
        // Only the JSON `true` (CONTRACT.md §16), and the key is ADDED rather than
        // set to `false`: a regular person's terminal is exactly the two keys it
        // has always been.
        if (parsed?.comped === true)
            state.terminal.comped = true;
        return;
    }
    const stopReason = providerStopReason(parsed);
    if (stopReason !== null)
        state.stopReason = stopReason;
    const images = providerImages(parsed);
    if (images.length) {
        if (!state.images)
            state.images = [];
        state.images.push(...images);
    }
    // `onDelta` stays the TEXT callback. An image is not a delta of the answer
    // being typed out, and an app that appended a data URL to its transcript
    // would render a wall of base64.
    const chunk = providerDelta(parsed);
    if (chunk) {
        state.text += chunk;
        onDelta?.(chunk);
    }
};
const errorFromBody = (status, requestId, body) => {
    const code = typeof body?.error === "string" ? body.error : "";
    const details = body && typeof body === "object" ? { ...body } : {};
    // An account on hold, before the switch and before the 401/403 fallback
    // below: the pipeline answers `403 {"error":"locked"}` on every app route
    // (x-mart/lib/zibby_web/plugs/app_token_auth.ex), and "Please sign in" is
    // false said to somebody who already is. The words are the ones
    // `transcribe` and `appData` already use for this refusal, so a person
    // reads one sentence whichever route said no. Gated on 403 deliberately:
    // that is the only shape the platform sends, and a 401 keeps reading
    // `unauthenticated` exactly as it did.
    if (status === 403 && code === "locked") {
        return new ZibbyAiError("locked", "Your account is on hold — check your Zibby account.", {
            status,
            requestId,
            details,
        });
    }
    switch (code) {
        case "insufficient_credits":
            return new ZibbyAiError("insufficient_credits", "Not enough credits.", {
                status,
                requestId,
                details,
            });
        case "session_cap_reached":
            return new ZibbyAiError("session_cap_reached", "Session spend cap reached.", {
                status,
                requestId,
                details,
            });
        case "rate_limited":
            return new ZibbyAiError("rate_limited", "Too many requests.", { status, requestId, details });
        case "unknown_model":
            return new ZibbyAiError("unknown_model", "This model is not available.", {
                status,
                requestId,
                details,
            });
        case "payload_too_large":
            return new ZibbyAiError("payload_too_large", "That upload is too large to send.", {
                status,
                requestId,
                details,
            });
        default:
            if (status === 401 || status === 403) {
                return new ZibbyAiError("unauthenticated", "Please sign in to use AI actions.", {
                    status,
                    requestId,
                    details,
                });
            }
            if (status === 429) {
                return new ZibbyAiError("rate_limited", "Too many requests.", {
                    status,
                    requestId,
                    details,
                });
            }
            return new ZibbyAiError("unknown", `AI request failed (${status}).`, {
                status,
                requestId,
                details,
            });
    }
};
/** Does this refusal name an account on hold? Read off a CLONE, so the
 *  response itself is still unread when `errorFromBody` takes its body — a
 *  `Response` body can only be read once. Anything unreadable (a body that is
 *  not JSON, a hand-made response with no `clone`) is `false`, which is the
 *  behaviour this path always had.
 *
 *  **TWIN: `namesLockedAccount` in `src/fetch.ts` — change both.** They are
 *  deliberately two (reviewed 2026-09-18): the stream path here does not go
 *  through `zibbyFetch`, sharing one would put a new name in `dist/` on a
 *  release whose export surface is pinned, and the two are not the same call
 *  — this one is gated by its caller on `status === 403`, the other gates
 *  itself. Four tokens of rule, pinned separately on both sides. */
const namesLockedAccount = async (response) => {
    try {
        const body = await response.clone().json();
        return body?.error === "locked";
    }
    catch {
        return false;
    }
};
/**
 * Run one AI action to completion.
 *
 * Resolves with received text and chargeKnown (false without a terminal).
 * Rejects with a `ZibbyAiError` whose `code` the UI switches on — the caller never inspects
 * HTTP status codes itself.
 */
export const streamZibbyAi = async (request, options = {}) => {
    if (isMockEnabled() && mockLoader) {
        const mockStream = await mockLoader();
        const mocked = await mockStream(request, options);
        // No `noteComped` here: the kit's mock engine mirrors its flag onto the
        // page itself (both ways), and a mock's answer is not the person's
        // standing, so it must not outlive the flag.
        // Normalize legacy mocks: images is always an array, and charge knowledge
        // always comes from the terminal, whatever flags the mock returned.
        return {
            ...mocked,
            images: mocked.images ?? [],
            stopReason: mocked.stopReason ?? null,
            model: mocked.model ?? null,
            chargeKnown: mocked.terminal !== null,
        };
    }
    const action = request.action;
    // The final negative lookahead says "and nothing after this" out loud.
    // JavaScript's `$` already means end-of-input without the `m` flag (checked:
    // /^abc$/.test("abc\n") is false), so the pattern is exact as printed; the
    // lookahead is belt to that brace — it survives somebody adding an `m`, and
    // it survives the pattern being copied into Elixir, PCRE, Ruby or Python,
    // where `$` is the looser one and a trailing newline WOULD pass. A header
    // must never carry one.
    const validAction = typeof action === "string" && /^[a-z0-9_:.-]{1,64}$(?![\s\S])/.test(action);
    if (!validAction)
        console.warn("[zibby] Invalid action label; omitting x-zibby-action:", action);
    const send = (token) => {
        const headers = { "content-type": "application/json" };
        if (token)
            headers["x-csrf-token"] = token;
        if (options.capAck)
            headers["x-zibby-cap-ack"] = "1";
        if (validAction)
            headers["x-zibby-action"] = action;
        return fetch(ZIBBY_AI_ENDPOINT, {
            method: "POST",
            credentials: "same-origin",
            headers,
            signal: options.signal,
            body: JSON.stringify({
                provider: request.provider,
                model: request.model,
                stream: true,
                payload: request.payload,
            }),
        });
    };
    const token = readCsrfToken();
    let response;
    try {
        response = await send(token);
        // On a per-app origin the token lives ten minutes and the shell refreshes
        // it, but a machine asleep past every refresh wakes up holding a dead
        // one. ONE re-ask over the bridge — carrying `refresh: true`, which is
        // what makes the shell MINT rather than repeat the cached token that just
        // failed — and one retry with what arrives. The re-ask is told which
        // token failed, so a shell that repeats it does not end the wait early;
        // see `requestFreshToken`. The cap-ack header (built inside `send`) rides
        // along, so the byte-identical cap retry works under a renewed token too.
        // A genuine signed-out 401 comes back `null` at once and falls through
        // unchanged.
        // …with ONE exception, additive 2026-09-18: a locked account. That 403 is
        // not about the token — the platform stopped the PERSON, on every app
        // route, before admission — so a minted token would be refused
        // identically. Re-asking would hold the caller for up to eight seconds
        // waiting for an answer that cannot change the outcome, and the retry
        // would spend a second refusal on it. The body is read through a CLONE so
        // the mapper below still reads the real one.
        if (response.status === 401 || response.status === 403) {
            if (!(response.status === 403 && (await namesLockedAccount(response)))) {
                const fresh = await requestFreshToken(token);
                if (fresh && fresh !== token)
                    response = await send(fresh);
            }
        }
    }
    catch (error) {
        if (error?.name === "AbortError")
            throw error;
        throw new ZibbyAiError("network", "Could not reach the AI service.");
    }
    const requestId = response.headers.get("x-zibby-request-id");
    if (!response.ok) {
        // A refusal always carries a JSON body per the contract; a proxy that dies
        // mid-flight may not, and that must not mask the status code.
        const body = await response.json().catch(() => null);
        throw errorFromBody(response.status, requestId, body);
    }
    if (!response.body) {
        throw new ZibbyAiError("malformed_stream", "The AI service returned an empty stream.", {
            requestId,
        });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = createStreamState();
    let buffer = "";
    for (;;) {
        let next;
        try {
            next = await reader.read();
        }
        catch (error) {
            if (error?.name === "AbortError")
                throw error;
            throw new ZibbyAiError("network", "The connection to the AI service dropped mid-answer.", {
                requestId,
            });
        }
        const { value, done } = next;
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = takeFrames(buffer);
        buffer = rest;
        for (const frame of frames)
            consumeFrame(frame, options.onDelta, state);
    }
    // Flush a final frame that arrived without a trailing blank line.
    const { frames } = takeFrames(`${buffer}\n\n`);
    for (const frame of frames)
        consumeFrame(frame, options.onDelta, state);
    // A live final event moves the page-wide value (`getComped()`) at once: a
    // comped one sets it, so a price chip drawn after this run hides before the
    // shell's next token answer; one that charged money without it withdraws
    // it. Only here, on a run that just happened: a pickup's shelved event may
    // be fifteen minutes old, as its balance may be (§11).
    noteComped(state.terminal?.comped, state.terminal?.charged_cr);
    return streamOutcome(state, requestId);
};
const pickupRequest = async (path, method) => {
    let response;
    try {
        response = await zibbyFetch(path, {
            method,
            headers: { "content-type": "application/json" },
            cache: "no-store",
        });
    }
    catch {
        throw new ZibbyAiError("network", "Could not reach the AI service.");
    }
    if (!response.ok) {
        throw errorFromBody(response.status, response.headers.get("x-zibby-request-id"), await response.json().catch(() => null));
    }
    return response;
};
/** Fetch pending runs without acknowledging them. Mock mode is always inert. */
export const pickupResults = async () => {
    if (isMockEnabled())
        return [];
    const response = await pickupRequest(`${ZIBBY_AI_ENDPOINT}/pickup`, "GET");
    const body = await response.json();
    return body.results.map(result => {
        const state = createStreamState();
        for (const frame of result.frames)
            consumeFrame(frame, undefined, state);
        return {
            requestId: result.request_id,
            appId: result.app_id,
            action: result.action,
            kind: result.kind,
            chargedCr: result.charged_cr,
            createdAt: result.created_at,
            outcome: streamOutcome(state, result.request_id),
        };
    });
};
/** Acknowledge a delivered run. Unknown ids reject with status 404. */
export const deletePickup = async (requestId) => {
    if (isMockEnabled())
        return;
    await pickupRequest(`${ZIBBY_AI_ENDPOINT}/pickup/${encodeURIComponent(requestId)}`, "DELETE");
};
