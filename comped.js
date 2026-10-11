// Whether the person in front of the app has their runs on Zibby — "comped"
// (additive, kit 0.7.0, CONTRACT.md §16).
//
// An admin, or a regular account an admin comped, runs apps on Zibby's pool:
// nothing is taken from their own wallet, and Zibby's own pages say "Comped:
// your runs are on Zibby". The platform tells an app so, additively, with one
// key — `comped: true` — on the `zibby:csrf` answer, on the `/api/ai` final
// event, on a transcription and on a job. For everybody else the key is never
// sent, and a platform older than this never sends it at all, so `false` is
// the answer an app has always had.
//
// The shape is `appUser.ts`'s: a module-scoped value, a `CustomEvent` for
// whoever renders it, and the publishers below. Nothing here talks to the
// network and nothing here writes to storage.
//
// ONLY THE JSON VALUE `true` COUNTS. Absent, `false`, `"true"`, `1` — anything
// else is a regular person, whose prices and charges an app shows exactly as
// before. Hiding a price from somebody who pays it is the worse mistake of the
// two, so the kit never guesses towards comped.
export const ZIBBY_COMPED_EVENT = "zibby:comped";
/** Zibby's own sentence for a person whose runs are on Zibby — the words its
 *  own pages say — so an app and the shell around it say one thing.
 *  `ChargedLine` says it in place of a comped run's charge (its `comped`
 *  prop); a hand-written charge line should too. */
export const ZIBBY_COMPED_LINE = "Comped: your runs are on Zibby";
/** What the shell last said, or what a run's own answer has said since. */
let comped = false;
/** What `@zibby-run/app-kit/mock` set for a development build. Kept apart
 *  from the shell's own value, exactly as the mock identity is in
 *  `appUser.ts`, so the mock bridge's anonymous handshake cannot wipe it;
 *  nothing in a production path writes it. */
let mockComped = false;
const announce = (previous) => {
    const current = getComped();
    if (current === previous)
        return;
    if (typeof window === "undefined")
        return;
    try {
        window.dispatchEvent(new CustomEvent(ZIBBY_COMPED_EVENT, { detail: { comped: current } }));
    }
    catch {
        // Announcing is best effort. It runs on the way back from a paid answer,
        // and a page whose event plumbing throws must not lose that answer.
    }
};
/**
 * `true` when this person's runs are on Zibby — so the app shows no price, no
 * charge and no balance moving, and says "Comped" where it would have.
 *
 * `false` means a regular person, OR that nothing has said otherwise yet: the
 * shell has not answered, nobody is signed in, or the platform predates the
 * field. In all of those the app shows what it always showed.
 *
 * Re-read it on the `zibby:comped` window event (or use `useComped()`): the
 * shell answers after mount, and a value read once at startup is `false` for
 * the rest of the session.
 */
export const getComped = () => comped || mockComped;
/** Called by the host bridge for every trusted token answer from the parent
 *  window. An answer that does not carry `comped: true` WITHDRAWS it — an admin
 *  ended the comp, or the person signed out — because a price hidden from
 *  somebody who now pays it is the one mistake here that costs them money. */
export const publishComped = (value) => {
    const previous = getComped();
    comped = value === true;
    announce(previous);
};
/** Called with a LIVE run's own answer — the `/api/ai` final event, a
 *  `transcribe()` result, a new job — never a pickup, a job read back or a
 *  mock. `comped: true` sets the value. An answer that CHARGED money
 *  (`charged_cr > 0`) without it withdraws the value at once: the platform has
 *  just billed this person, so an admin ended the comp, and a price hidden from
 *  somebody who now pays it is the mistake that costs them money. A free
 *  answer (`charged_cr` 0, or none yet) says nothing either way — a regular
 *  person's free call looks the same. */
export const noteComped = (value, chargedCr) => {
    const previous = getComped();
    if (value === true)
        comped = true;
    else if (typeof chargedCr === "number" && Number.isFinite(chargedCr) && chargedCr > 0)
        comped = false;
    else
        return;
    announce(previous);
};
/** Dev only, and not exported from the package's entry points: the mocks
 *  MIRROR `window.__zibbyAiMock`'s `comped` through this on every answer —
 *  both ways, so a dev page stops playing a comped viewer the moment the flag
 *  does — and the mock host bridge sets it at install and clears it on its
 *  teardown. */
export const setMockComped = (value) => {
    const previous = getComped();
    mockComped = value === true;
    announce(previous);
};
