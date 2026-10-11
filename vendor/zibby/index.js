export { ZIBBY_AI_ENDPOINT, ZIBBY_APP_DATA_ENDPOINT, ZIBBY_CREDITS_PATH, ZIBBY_CSRF_META_NAMES, ZIBBY_PAGE_TEXT_ENDPOINT, ZIBBY_TRANSCRIBE_ENDPOINT, } from "./config.js";
export { zibbyFetch, } from "./fetch.js";
// The app's own small JSON store, kept by the platform against the signed-in
// person and this app (CONTRACT.md §12). Free, versioned, and scoped by the
// app token alone — the app never names a user.
export { appData, isAppDataName, setAppDataMockLoader, ZibbyAppDataError, ZIBBY_APP_DATA_MAX_BYTES, ZIBBY_APP_DATA_MAX_DOCUMENTS, ZIBBY_APP_DATA_MAX_DOCUMENT_BYTES, ZIBBY_APP_DATA_MAX_LIST_LIMIT, } from "./appData.js";
// This app's own name for the signed-in person — a convenience for the app's
// own logic, never a credential (CONTRACT.md §4).
export { getAppUserId, ZIBBY_APP_USER_EVENT } from "./appUser.js";
// Whether this person's runs are on Zibby — an admin, or an account an admin
// comped (CONTRACT.md §16, additive 0.7.0). `true` means no price, no charge.
export { getComped, ZIBBY_COMPED_EVENT, ZIBBY_COMPED_LINE } from "./comped.js";
// Speech to text (CONTRACT.md §8). One request, one answer, one charge — and
// an endpoint that is NOT idempotent, so nothing here retries on its own.
export { transcribe, setTranscribeMockLoader, ZibbyTranscribeError, ZIBBY_TRANSCRIBE_BODY_CAP_BYTES, ZIBBY_TRANSCRIBE_DIARIZE_MAX_SECONDS, ZIBBY_TRANSCRIBE_MAX_AUDIO_BYTES, ZIBBY_TRANSCRIPTION_MODELS, } from "./transcribe.js";
// Known speakers (CONTRACT.md §8 and §15, additive 0.6.0): the names a
// diarizing transcription puts on its segments, on both transcribe routes.
export { ZIBBY_KNOWN_SPEAKERS_MAX, ZIBBY_KNOWN_SPEAKER_MAX_NAME_LENGTH, ZIBBY_KNOWN_SPEAKER_MAX_SAMPLE_BYTES, ZIBBY_KNOWN_SPEAKER_MAX_SECONDS, ZIBBY_KNOWN_SPEAKER_MIN_SECONDS, } from "./knownSpeakers.js";
// The person's files in this app, and the shell's file picker (CONTRACT.md
// §14, additive 0.6.0). Free, per person per app, scoped by the app token.
export { files, setFilesMockLoader, ZibbyFilesError, ZIBBY_APP_FILES_ENDPOINT, ZIBBY_FILES_AUDIO_RETENTION_DAYS, ZIBBY_FILES_DOWNLOAD_TTL_S, ZIBBY_FILES_MAX_AUDIO_BYTES, ZIBBY_FILES_MAX_FILES, ZIBBY_FILES_MAX_LIST_LIMIT, ZIBBY_FILES_MAX_OTHER_BYTES, ZIBBY_FILES_QUOTA_BYTES, ZIBBY_PICK_CANCELLED_MESSAGE, ZIBBY_PICK_FILE_MESSAGE, ZIBBY_PICKED_MESSAGE, } from "./files.js";
// Background transcription of a stored recording (CONTRACT.md §15, additive
// 0.6.0). Charged once, on success; polled, and pushed while the app is open.
export { jobs, setTranscribeJobsMockLoader, transcribeJob, ZibbyJobError, ZIBBY_JOB_MESSAGE, ZIBBY_TRANSCRIBE_JOB_MODEL, ZIBBY_TRANSCRIBE_JOBS_ENDPOINT, ZIBBY_TRANSCRIBE_JOBS_MAX_OPEN, } from "./transcribeJobs.js";
export { streamZibbyAi, pickupResults, deletePickup, consumeFrame, isMockEnabled, setMockLoader, ZibbyAiError, } from "./client.js";
export { installHostBridge, navigateHost, track, readCsrfToken, readAvgActionCr, requestFreshToken, ZIBBY_CSRF_MESSAGE, ZIBBY_HELLO_MESSAGE, ZIBBY_NAVIGATE_MESSAGE, ZIBBY_TRACK_MESSAGE, ZIBBY_ERROR_MESSAGE, ZIBBY_QUOTE_EVENT, } from "./hostBridge.js";
// The app's half of leaving the app: the six-path allow-list, the label for
// each, and `hostNavigate` — `navigateHost` with the allow-list in front of
// it. `navigateHost` above is the primitive (it posts the message); this is
// the surface an app's links actually call, and the one that answers "is this
// a path I route?" with a boolean instead of a console warning.
export { SHELL_HOST_ROOT, isShellPath, shellPathLabel, isEmbedded, fallbackHref, hostNavigate, } from "./hostNav.js";
export { publishBalance, ZIBBY_BALANCE_EVENT } from "./balance.js";
export { openSavedResults, } from "./savedResults.js";
