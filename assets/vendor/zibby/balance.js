// The tiny contract between "something was charged" and "a toolbar slot shows
// a new number". Kept free of any UI framework so non-React code can publish.
export const ZIBBY_BALANCE_EVENT = "zibby:balance";
/** Announce a fresh balance to whoever renders it. Called after every charged
 *  action with the `balance_cr` from the proxy's terminal SSE event. */
export const publishBalance = (balanceCr) => {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(ZIBBY_BALANCE_EVENT, { detail: { balance_cr: balanceCr } }));
};
