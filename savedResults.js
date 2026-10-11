const STORE = "results";
const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 20;
let nextId = 0;
const cap = (value, fallback) => value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
// A deterministic tie-break also makes eviction identical across store handles.
const oldestFirst = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Best-effort, browser-only persistence. Storage failures disable this handle. */
export function openSavedResults(appKey, options = {}) {
    const maxBytes = cap(options.maxBytes, DEFAULT_MAX_BYTES);
    const maxItems = cap(options.maxItems, DEFAULT_MAX_ITEMS);
    let available = true;
    let database;
    const disable = () => {
        available = false;
        try {
            database?.close();
        }
        catch { /* Storage must never break the app. */ }
        database = undefined;
    };
    const opened = new Promise(resolve => {
        const failed = () => { disable(); resolve(null); };
        try {
            if (!globalThis.indexedDB) {
                failed();
                return;
            }
            const request = globalThis.indexedDB.open(`zibby-saved-results:${appKey}`, 1);
            request.onerror = failed;
            request.onblocked = failed;
            request.onupgradeneeded = () => {
                try {
                    if (!available) {
                        request.transaction?.abort();
                        return;
                    }
                    request.result.createObjectStore(STORE, { keyPath: "id" });
                }
                catch {
                    failed();
                }
            };
            request.onsuccess = () => {
                // A blocked open can eventually succeed after its caller has moved on.
                try {
                    if (!available) {
                        request.result.close();
                        return;
                    }
                    database = request.result;
                    database.onversionchange = disable;
                    database.onclose = disable;
                    resolve(database);
                }
                catch {
                    failed();
                }
            };
        }
        catch {
            failed();
        }
    });
    // Preserve invocation order on this handle, including calls made while opening.
    // IndexedDB itself serializes read/write transactions across other handles/tabs.
    let pending = Promise.resolve();
    const transaction = (mode, fallback, work) => {
        const operation = pending.then(async () => {
            const db = await opened;
            if (!available || !db)
                return fallback;
            return new Promise(resolve => {
                let tx;
                let value = fallback;
                const fail = () => {
                    try {
                        tx?.abort();
                    }
                    catch { /* Already completed or aborted. */ }
                    disable();
                    resolve(fallback);
                };
                try {
                    tx = db.transaction(STORE, mode);
                    tx.oncomplete = () => resolve(value);
                    tx.onerror = fail;
                    tx.onabort = fail;
                    work(tx.objectStore(STORE), result => { value = result; }, fail);
                }
                catch {
                    fail();
                }
            });
        }).catch(() => { disable(); return fallback; });
        pending = operation;
        return operation;
    };
    return {
        get available() { return available; },
        save(input) {
            return transaction("readwrite", undefined, (store, _result, fail) => {
                const record = {
                    ...input,
                    id: input.id ?? globalThis.crypto?.randomUUID?.() ??
                        `${Date.now().toString(36)}-${++nextId}-${Math.random().toString(36).slice(2)}`,
                    createdAt: input.createdAt ?? Date.now(),
                    bytes: input.bytes ?? (typeof input.payload === "string"
                        ? new TextEncoder().encode(input.payload).byteLength : input.payload.size),
                };
                store.put(record);
                const request = store.getAll();
                request.onsuccess = () => {
                    try {
                        const records = request.result.sort(oldestFirst);
                        let bytes = records.reduce((total, row) => total + row.bytes, 0);
                        let items = records.length;
                        for (const row of records) {
                            if (bytes <= maxBytes && items <= maxItems)
                                break;
                            store.delete(row.id);
                            bytes -= row.bytes;
                            items--;
                        }
                    }
                    catch {
                        fail();
                    }
                };
            });
        },
        list() {
            return transaction("readonly", [], (store, result, fail) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    try {
                        result(request.result.sort(oldestFirst).reverse());
                    }
                    catch {
                        fail();
                    }
                };
            });
        },
        remove(id) {
            return transaction("readwrite", undefined, store => { store.delete(id); });
        },
        clear() {
            return transaction("readwrite", undefined, store => { store.clear(); });
        },
    };
}
