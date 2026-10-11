// Known speakers — the names a diarizing transcription puts on its segments
// instead of `A`, `B`, `C` (CONTRACT.md §8 and §15, additive, 0.6.0).
//
// An app sends up to four people, each with a short reference sample of
// their voice, and `openai/gpt-4o-transcribe-diarize` labels every segment
// that voice spoke with the NAME it was given — and labels it the same way in
// every recording, which "A" and "B" never were (they are renumbered per
// call). Both transcription routes take the field: `transcribe()` for a
// recording sent inline, and `transcribeJob()` for one kept in the app's
// files.
//
// The rules below are the platform's (`Zibby.Transcribe.KnownSpeakers`),
// repeated here so that a malformed list is refused BEFORE a recording is
// read, encoded or uploaded — and refused with the platform's own sentence,
// which names the entry's POSITION and never its name: a name is the
// person's content, and an error travels to logs and to `window.onerror`.
//
// THE SAMPLES' SECONDS ARE BILLED. Each speaker's `durationS` is added to the
// recording's measured duration, bounded 2–10 seconds — so four samples add
// at most 40 seconds to the charge. Declare the real length.
//
// Nothing here stores anything. The platform sends the names and samples to
// the model provider, keeps a job's samples only until the job finishes, and
// keeps the names (and seconds) on the job record for its 30 days.
/** At most four people per recording — the provider's own limit. */
export const ZIBBY_KNOWN_SPEAKERS_MAX = 4;
/** A name is 1–60 characters after trimming. */
export const ZIBBY_KNOWN_SPEAKER_MAX_NAME_LENGTH = 60;
/** A sample is 2 to 10 seconds long — the provider's own bounds for a voice
 *  reference, and the bounds each sample's billed seconds are clamped to. */
export const ZIBBY_KNOWN_SPEAKER_MIN_SECONDS = 2;
export const ZIBBY_KNOWN_SPEAKER_MAX_SECONDS = 10;
/** A sample is at most 1 MB (1,048,576 bytes) of audio — ten seconds of
 *  44.1 kHz 16-bit mono WAV is 882 KB, and every compressed format is far
 *  less. The platform refuses a larger one, inline or stored. */
export const ZIBBY_KNOWN_SPEAKER_MAX_SAMPLE_BYTES = 1048576;
const isBlob = (value) => typeof Blob !== "undefined" && value instanceof Blob;
/** The id shape the platform casts (`Ecto.UUID.cast/1`): 36 characters,
 *  hyphenated, hex in either case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
/** Control (`Cc`) and format (`Cf`) characters — the platform's
 *  `[\p{Cc}\p{Cf}]`, character class for character class. `Cf` is where the
 *  invisible ones live: zero-width joiners, bidirectional overrides. */
const NOT_PLAIN = /[\p{Cc}\p{Cf}]/u;
const bad = (message) => ({ message });
/** Graphemes where the browser can count them (`Intl.Segmenter`), code points
 *  where it cannot. Code points are never FEWER than graphemes, so the
 *  fallback can only be stricter than the platform (a 60-emoji name with skin
 *  tones), never laxer — a refusal the person mends by shortening the name,
 *  never a request the platform refuses after the upload. */
const graphemes = (text) => {
    try {
        const Segmenter = Intl?.Segmenter;
        if (typeof Segmenter === "function") {
            let count = 0;
            for (const _ of new Segmenter(undefined, { granularity: "grapheme" }).segment(text))
                count += 1;
            return count;
        }
    }
    catch {
        // Fall through to code points.
    }
    return Array.from(text).length;
};
/** A stored-file reference's id, or `null` when `file` is not one. */
const storedId = (file) => {
    if (typeof file === "string")
        return file;
    if (file && typeof file === "object" && !isBlob(file) && typeof file.id === "string") {
        return file.id;
    }
    return null;
};
/**
 * The platform's shape rules, in the platform's order and with its words:
 * the list, then each entry's name, duration and source, then the names'
 * uniqueness. Answers the checked list, or the first problem.
 *
 * `undefined`, `null` and `[]` are "no known speakers" — nothing is sent.
 */
export const checkKnownSpeakers = (list) => {
    if (list === undefined || list === null)
        return { ok: true, speakers: [] };
    if (!Array.isArray(list))
        return { ok: false, problem: bad("known_speakers must be a list") };
    if (list.length > ZIBBY_KNOWN_SPEAKERS_MAX) {
        return {
            ok: false,
            problem: bad(`known_speakers takes at most ${ZIBBY_KNOWN_SPEAKERS_MAX} speakers`),
        };
    }
    const speakers = [];
    for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        const at = `known_speakers[${index}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return { ok: false, problem: bad(`${at} must be an object`) };
        }
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (name === "")
            return { ok: false, problem: bad(`${at}.name is required`) };
        // Characters as a person sees them — the platform's `String.length/1`
        // counts graphemes, not UTF-16 units.
        if (graphemes(name) > ZIBBY_KNOWN_SPEAKER_MAX_NAME_LENGTH) {
            return {
                ok: false,
                problem: bad(`${at}.name is longer than ${ZIBBY_KNOWN_SPEAKER_MAX_NAME_LENGTH} characters`),
            };
        }
        if (NOT_PLAIN.test(name))
            return { ok: false, problem: bad(`${at}.name must be plain text`) };
        const seconds = entry.durationS;
        if (typeof seconds !== "number" ||
            !Number.isFinite(seconds) ||
            seconds < ZIBBY_KNOWN_SPEAKER_MIN_SECONDS ||
            seconds > ZIBBY_KNOWN_SPEAKER_MAX_SECONDS) {
            return {
                ok: false,
                problem: bad(`${at}.duration_s must be the sample's length, ` +
                    `${ZIBBY_KNOWN_SPEAKER_MIN_SECONDS} to ${ZIBBY_KNOWN_SPEAKER_MAX_SECONDS} seconds`),
            };
        }
        // Exactly one source. `file` holding a Blob is an inline sample.
        const inlineFromFile = isBlob(entry.file) ? entry.file : null;
        const id = inlineFromFile ? null : storedId(entry.file);
        const hasFile = entry.file !== undefined && entry.file !== null;
        const hasAudio = entry.audio !== undefined && entry.audio !== null;
        if (hasFile && hasAudio) {
            return { ok: false, problem: bad(`${at} takes a file_id or an audio sample, not both`) };
        }
        if (id !== null) {
            if (!UUID.test(id))
                return { ok: false, problem: bad(`${at}.file_id is not a file id`) };
            speakers.push({ name, durationS: seconds, source: { kind: "file", id } });
            continue;
        }
        const blob = inlineFromFile ?? (isBlob(entry.audio) ? entry.audio : null);
        if (!blob || blob.size === 0) {
            if (hasFile && !inlineFromFile) {
                return { ok: false, problem: bad(`${at}.file_id is not a file id`) };
            }
            return { ok: false, problem: bad(`${at} needs a file_id or audio.data`) };
        }
        if (blob.size > ZIBBY_KNOWN_SPEAKER_MAX_SAMPLE_BYTES) {
            return {
                ok: false,
                problem: bad(`${at} sample is larger than ${ZIBBY_KNOWN_SPEAKER_MAX_SAMPLE_BYTES / 1024} KB`),
            };
        }
        speakers.push({ name, durationS: seconds, source: { kind: "inline", blob } });
    }
    // Case-insensitively, as the platform compares them: OpenAI maps name i to
    // sample i, and two samples under one name is a question nobody can answer.
    const lowered = speakers.map(speaker => speaker.name.toLowerCase());
    if (new Set(lowered).size !== lowered.length) {
        return { ok: false, problem: bad("known_speakers names must be different from each other") };
    }
    return { ok: true, speakers };
};
/** Base64 bytes a sample will occupy on the wire — 4 per 3, padded. The
 *  inline route's body cap has to leave room for them. */
export const inlineSampleBytes = (speakers) => speakers.reduce((total, speaker) => speaker.source.kind === "inline"
    ? total + 4 * Math.ceil(speaker.source.blob.size / 3) + 256
    : total + 128, 0);
/** The checked list, in the platform's wire shape. Inline samples are read
 *  and base64-encoded here, and only here — after every check has passed. */
export const encodeKnownSpeakers = async (speakers, toBase64) => {
    const out = [];
    for (const speaker of speakers) {
        if (speaker.source.kind === "file") {
            out.push({ name: speaker.name, duration_s: speaker.durationS, file_id: speaker.source.id });
        }
        else {
            const data = toBase64(new Uint8Array(await speaker.source.blob.arrayBuffer()));
            out.push({ name: speaker.name, duration_s: speaker.durationS, audio: { data } });
        }
    }
    return out;
};
