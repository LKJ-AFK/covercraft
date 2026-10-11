// The per-app name the platform has for the person in front of the app —
// cached here, published as an event, and never invented, persisted or sent.
//
// The shape is `balance.ts`'s, one size up: a module-scoped cache, a
// `CustomEvent` for whoever renders it, and a publisher the host bridge calls
// when a trusted `zibby:csrf` answer arrives. Nothing here talks to the
// network and nothing here writes to storage.
//
// WHAT IT IS (CONTRACT.md §4 and §12). `app_user_id` is a string of the form
// `u_` followed by 26 lower-case base32 characters — stable for one person in
// one app across sessions, devices and republishes, different for the same
// person in any other app. The platform sends it ONLY when the token is
// non-null AND the app's "Stores user data" switch is on: three conditions,
// all required, so an app that holds a perfectly good token may still never
// see one, and its absence means "this app was not given one" and nothing
// else.
//
// WHAT IT IS NOT: a credential. No route on the platform accepts it as proof
// of who is calling, the store scopes every request by the app token alone,
// and an app's own backend must not trust one a browser hands it.
export const ZIBBY_APP_USER_EVENT = "zibby:appuser";
/** What the shell last told this app. `null` is a real answer — nobody is
 *  signed in, or this app was not given a name for them. */
let bridgeId = null;
/** What `@zibby-run/app-kit/mock` set for a development build. Kept apart from
 *  the bridge's own value so that a real answer always wins and a signed-out
 *  answer cannot wipe the dev identity; nothing in a production path writes
 *  it, and the module it is set from is loaded lazily. */
let mockId = null;
/** A type check, not a grammar check, and deliberately so: the platform owns
 *  the format and may widen it (a longer id, a new prefix) without a kit
 *  release, and a kit that enforced today's 28 characters would answer `null`
 *  in every already-published bundle on the day it did. Anything that is not
 *  a plain, non-empty, sanely-bounded string is not an id the platform sent.
 *
 *  It is TRIMMED before it is accepted: an app keyed on a padded id would
 *  hold two names for one person, and an app that asserts the documented
 *  `u_` + 26 shape would call a perfectly good id malformed. The bound is
 *  checked on the string as it arrived, so padding cannot smuggle a longer
 *  one past it. */
const accept = (value) => {
    if (typeof value !== "string" || value.length > 128)
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
const announce = (previous) => {
    const current = bridgeId ?? mockId;
    if (current === previous)
        return;
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(ZIBBY_APP_USER_EVENT, { detail: { app_user_id: current } }));
};
/**
 * This app's id for the signed-in person, or `null`.
 *
 * `null` has four meanings and an app should treat them alike: nobody is
 * signed in, the shell has not answered yet, this app has not been switched on
 * for user data, or the platform predates the field. In all four the app has
 * no name for the person and its data store is unreachable — so build the
 * feature to degrade, not to wait.
 *
 * Re-read it on the `zibby:appuser` window event (or use `useAppUser()`): the
 * shell answers after mount and again on its refresh interval, so a value read
 * once at startup is a value that can be wrong for the rest of the session.
 */
export const getAppUserId = () => bridgeId ?? mockId;
/** Called by the host bridge for every trusted token answer, with whatever
 *  the answer carried — including nothing, which WITHDRAWS the id. A stale id
 *  is worse than none: it is the last person's. */
export const publishAppUserId = (value) => {
    const previous = bridgeId ?? mockId;
    bridgeId = accept(value);
    announce(previous);
};
/** Dev only, and not exported from the package's entry points: the mock store
 *  and the mock host bridge hand a development build a fake identity through
 *  this. It never outranks a real one. */
export const setMockAppUserId = (value) => {
    const previous = bridgeId ?? mockId;
    mockId = accept(value);
    announce(previous);
};
