/**
 * Small LRU cache + in-flight request de-duplication for EzClassifyClient.
 *
 * Typical traffic: autocomplete typeahead fires suggest(input) per keystroke; a
 * live rollup fires process(input) per field edit; describeConcept runs on
 * hover. Without memoization the cost, and more importantly the server
 * bandwidth, scales with user activity rather than with the number of distinct
 * questions asked, and an interactive page asks the same question many times
 * over.
 *
 * Properties:
 *
 * - In-flight dedup: two near-simultaneous suggest calls with the same input
 *   share the same underlying Promise; only one HTTP request is made.
 * - Cancellation is per caller, not per request. Dedup means one wire trip can
 *   have several callers behind it, each holding its own AbortSignal. Aborting
 *   one settles that caller and leaves the others alone; the wire trip is
 *   aborted only when the last caller has walked away.
 * - Independent results: the cache keeps the one value the request produced and
 *   hands every caller its own structured copy. A caller that edits what it was
 *   handed, or a caller that joined a shared request, cannot change what
 *   another caller holds or what a later read returns. The price is one
 *   `structuredClone` per call, proportional to the size of the result; the
 *   alternative, handing out the stored value, lets one consumer corrupt the
 *   entry for every other, and under a version pin that entry never expires.
 * - Stable ordering of entries for LRU eviction via Map insertion order, which JS
 *   Maps preserve by spec. Touching an entry (get / set) moves it to the MRU
 *   position.
 * - No dependency on an external LRU package. Kept tiny so the bundle stays small
 *   for edge runtimes.
 */

import { EzClassifyError, ErrorCodes } from './errors';
import { isDeadlineAbort } from './request-budget';

/** Per-entry state in the cache. */
interface Entry<T> {
    /** Key this entry is filed under, so a waiter can evict it on the way out. */
    key: string;
    /** Shared Promise: returned to every caller while pending or fresh. */
    value: Promise<T>;
    /**
     * Ms-since-epoch after which the entry is considered stale.
     * `Number.POSITIVE_INFINITY` for an entry that never goes stale, which is
     * what a caller bound to an immutable version asks for: nothing but LRU
     * eviction removes it.
     */
    expiresAt: number;
    /** Aborts the one underlying request the waiters share. */
    controller: AbortController;
    /** Callers still waiting on the shared result. */
    waiters: number;
    /** The shared request has finished: canceling it can no longer help. */
    settled: boolean;
}

/**
 * Default entry lifetime for an unpinned client that names no TTL of its own.
 * One constant because the client and the cache both have to answer with it,
 * and two copies drift.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The longest any entry may live on a binding that can move: one hour, from the
 * shared cache contract (C11). Only a version pin holds entries longer, because
 * only a pin names a composition that cannot change.
 */
export const MAX_UNPINNED_TTL_MS = 60 * 60 * 1000;

/** Options accepted by the RequestCache constructor. */
export interface RequestCacheOptions {
    /** Max entries kept; least-recently-used evicted past this. Default 500. */
    maxEntries?: number;
    /** Default TTL for entries that don't specify one. Default 5 min. */
    defaultTtlMs?: number;
}

/** Per-call options for {@link RequestCache.get}. */
export interface RequestCacheGetOptions {
    /**
     * Lifetime for a newly created entry. Defaults to the cache's own TTL.
     * `Number.POSITIVE_INFINITY` files the entry with no expiry at all, for a
     * caller that knows its answer cannot change.
     */
    ttlMs?: number;
    /**
     * This caller's cancellation signal. It settles this caller only; the
     * shared request lives as long as any other caller still wants it.
     */
    signal?: AbortSignal;
    /** Operation name, used in the abort error message. */
    label?: string;
}

/**
 * The error a caller whose signal aborted receives, matching the uncached wire
 * path: a signal that timed out is `TIMEOUT`, any other abort is `ABORTED`.
 */
function abortError(reason: unknown, label?: string): EzClassifyError {
    if (isDeadlineAbort(reason)) {
        return new EzClassifyError(
            `Request to ${label ?? 'the server'} timed out: the deadline on its signal elapsed`,
            ErrorCodes.TIMEOUT,
        );
    }
    return new EzClassifyError(
        label ? `Request aborted: ${label}` : 'Request aborted',
        ErrorCodes.ABORTED,
    );
}

/**
 * A caller's own copy of a cached value.
 *
 * Results are decoded JSON, so a structured copy is exact. Primitives are
 * immutable already and are returned as they are.
 */
function ownCopy<T>(value: T): T {
    return typeof value === 'object' && value !== null
        ? structuredClone(value)
        : value;
}

/**
 * Small LRU cache that also de-duplicates in-flight requests for the same key.
 * get(key, thunk, ttlMs?) returns the cached value if the entry is still fresh,
 * otherwise calls thunk once and memoizes its Promise.
 */
export class RequestCache {
    private readonly _map: Map<string, Entry<unknown>> = new Map();
    private readonly _maxEntries: number;
    private readonly _defaultTtlMs: number;

    constructor(options?: RequestCacheOptions) {
        this._maxEntries = options?.maxEntries ?? 500;
        this._defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_CACHE_TTL_MS;
    }

    /**
     * Return the memoized value for key. If no fresh entry exists, invoke thunk
     * once and cache its Promise: every concurrent caller awaits the same
     * Promise until it resolves or rejects. On rejection the entry is evicted
     * so the next call retries.
     *
     * The thunk receives the signal for the shared request. It is not the
     * caller's signal: several callers can be waiting on one request, so the
     * cache aborts it only once they have all canceled.
     *
     * An entry given `Number.POSITIVE_INFINITY` for its TTL is never stale, so
     * it is served until LRU eviction or an explicit `clear` takes it out.
     *
     * @param key - Cache key, from {@link cacheKeyForWireValue}
     * @param thunk - Starts the underlying request, given the shared signal
     * @param options - Per-call TTL, caller signal, and label
     * @returns This caller's view of the shared result
     */
    get<T>(
        key: string,
        thunk: (signal: AbortSignal) => Promise<T>,
        options?: RequestCacheGetOptions,
    ): Promise<T> {
        const signal = options?.signal;
        if (signal?.aborted)
            return Promise.reject(abortError(signal.reason, options?.label));

        const now = Date.now();
        const existing = this._map.get(key) as Entry<T> | undefined;
        // A pending request has no response to expire. Keep sharing its wire
        // trip even if the request takes longer than the configured TTL.
        if (existing && (!existing.settled || existing.expiresAt > now)) {
            this._map.delete(key);
            this._map.set(key, existing);
            return this._join(existing, signal, options?.label);
        }

        const ttlMs = options?.ttlMs ?? this._defaultTtlMs;
        const controller = new AbortController();
        const promise = thunk(controller.signal);
        const entry: Entry<T> = {
            key,
            value: promise,
            expiresAt: Number.POSITIVE_INFINITY,
            controller,
            waiters: 0,
            settled: false,
        };
        // Replacing an expired entry reuses its key, and a Map set on a key it
        // already holds leaves the old insertion position alone. Deleting
        // first puts the new entry at the most-recently-used end where it
        // belongs, instead of leaving it first in line for eviction.
        this._map.delete(key);
        this._map.set(key, entry as Entry<unknown>);

        promise.then(
            () => {
                entry.settled = true;
                entry.expiresAt = Date.now() + ttlMs;
            },
            () => {
                entry.settled = true;
                const current = this._map.get(key);
                if (current && current.value === entry.value) {
                    this._map.delete(key);
                }
            },
        );

        this._evictIfFull();
        return this._join(entry, signal, options?.label);
    }

    /**
     * Attach one caller to an entry. Without a signal the caller simply awaits
     * the shared Promise; with one it gets a view that can settle early without
     * disturbing the other callers. Either way the value the caller receives is
     * its own copy.
     */
    private _join<T>(
        entry: Entry<T>,
        signal: AbortSignal | undefined,
        label: string | undefined,
    ): Promise<T> {
        entry.waiters += 1;
        if (!signal) return entry.value.then(ownCopy);
        return new Promise<T>((resolve, reject) => {
            const onAbort = (): void => {
                this._leave(entry);
                reject(abortError(signal.reason, label));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            const detach = (): void =>
                signal.removeEventListener('abort', onAbort);
            entry.value.then(
                (value) => {
                    detach();
                    resolve(ownCopy(value));
                },
                (err: unknown) => {
                    detach();
                    reject(err);
                },
            );
        });
    }

    /**
     * Drop one caller from an entry. The request outlives any single caller;
     * once the last one has gone there is nobody left to answer, so the entry
     * is evicted and the request canceled.
     */
    private _leave(entry: Entry<unknown>): void {
        if (entry.settled) return;
        entry.waiters -= 1;
        if (entry.waiters > 0) return;
        if (this._map.get(entry.key) === entry) this._map.delete(entry.key);
        entry.controller.abort();
    }

    /** Clear everything. Used on reconnect / profile refresh. */
    clear(): void {
        this._map.clear();
    }

    /** How many entries are currently held. Primarily for tests. */
    get size(): number {
        return this._map.size;
    }

    /**
     * Callers currently waiting on requests that have not settled. A call joins
     * its entry before it returns, so a test that starts callers and reads this
     * knows they are all behind the shared request.
     *
     * @internal
     */
    get pendingWaiters(): number {
        let total = 0;
        for (const entry of this._map.values()) {
            if (!entry.settled) total += entry.waiters;
        }
        return total;
    }

    /** Drop least-recently-used entries past the size cap. */
    private _evictIfFull(): void {
        while (this._map.size > this._maxEntries) {
            const firstKey = this._map.keys().next().value;
            if (firstKey === undefined) break;
            this._map.delete(firstKey);
        }
    }
}

/**
 * Build a stable cache key from op name + composition + a value already frozen
 * by {@link wireSnapshot}.
 *
 * Object keys are sorted so {a:1,b:2} and {b:2,a:1} hash identically: the
 * caller can hand in any object without pre-sorting.
 *
 * @param op - Operation name, unique per adapter method
 * @param composition - Composition the op ran against: the scheme stack, or the
 *   Context binding on a context-bound client
 * @param wireValue - The request body, as {@link wireSnapshot} froze it
 * @returns The cache key for that exact request
 */
export function cacheKeyForWireValue(
    op: string,
    composition: string | undefined,
    wireValue: unknown,
): string {
    return `${op}::${composition ?? '*'}::${stableStringify(wireValue)}`;
}

/**
 * Freeze the JSON value a request body will put on the wire. JSON.stringify
 * applies toJSON, drops absent members and converts non-finite numbers before
 * the cache sees them. Reusing this snapshot for the actual request also keeps
 * a stateful toJSON hook from changing the body after the key was chosen.
 */
export function wireSnapshot(value: unknown): unknown {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

/**
 * Serialize a payload the way the wire will see it, with object keys ordered.
 *
 * Undefined members are dropped and undefined array elements become null, which
 * is what `JSON.stringify` does to the request body a moment later. Two calls
 * that put identical bytes on the wire have to land on one entry: `{format:
 * undefined}` from an options bag that spread a missing field is the same
 * request as one that never mentioned `format`, and filing it separately buys a
 * second round trip for an answer already in hand. It also keeps the key
 * expressible in languages with no undefined at all, which the other SDKs
 * need.
 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
