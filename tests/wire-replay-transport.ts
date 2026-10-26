/**
 * The transport a corpus replay runs through: a `fetchImpl` that accepts only
 * the requests a named set of corpus cases recorded, and answers each with the
 * response the runtime gave.
 *
 * It is deliberately not a server. It matches nothing it was not told to
 * expect, so a client that changes a path, a method, a body field, or the order
 * of an array stops matching and the case fails with the emitted request beside
 * the recorded one. That refusal is the assertion; there is no separate "did
 * the request look right" step to forget to write.
 *
 * Matching uses the canonical forms from `@ezclassify/conformance-server`, the
 * same ones the replay server matches on, so the in-process lane and the HTTP
 * lane agree about what counts as the same request by construction rather than
 * by two implementations happening to line up.
 */

import { matchKey } from '@ezclassify/conformance-server';
import type { LoadedWireCorpus, WireCase } from './wire-corpus';

/** One request the client emitted, as the transport saw it. */
export interface EmittedRequest {
    /** HTTP method. */
    method: string;
    /** Request target: path and query, with the base URL removed. */
    target: string;
    /** Header names lowercased. */
    headers: Record<string, string>;
    /** Parsed request body, or undefined when the request carried none. */
    body: unknown;
    /** Id of the corpus case this request matched. */
    caseId: string;
    /**
     * The signal the client gave this request. On a cached client it is the
     * shared entry's, not any one caller's, which is what makes it worth
     * keeping: a cancellation reaching it means one caller canceled a trip
     * other callers were still waiting on.
     */
    signal?: AbortSignal;
}

/** Extra per-driver checks on a request the transport already matched. */
export type RequestAssertion = (request: EmittedRequest) => void;

/** How a transport behaves beyond matching. */
export interface ReplayTransportOptions {
    /** Extra checks on each matched request. */
    assertRequest?: RequestAssertion;
    /**
     * Serve each case as often as it is asked for rather than once.
     *
     * The replay lane wants exactly-once: a case served twice would hide a
     * client that lost track of a response. The cache lane wants the opposite,
     * because how many times a request is emitted is the thing under test.
     */
    repeatable?: boolean;
    /** Held before the response is produced, to open a window mid-flight. */
    beforeRespond?: (request: EmittedRequest) => Promise<void> | void;
}

/** The carrier header a context-bound client sends its Context authorization in. */
const CONTEXT_TOKEN_HEADER = 'x-ezclassify-context-token';

/** Base URL every replay client is pointed at. Never dialed. */
export const REPLAY_BASE_URL = 'https://replay.invalid';

function lowercaseHeaders(init?: RequestInit): Record<string, string> {
    const headers: Record<string, string> = {};
    const source = init?.headers as Record<string, string> | undefined;
    for (const [name, value] of Object.entries(source ?? {})) {
        headers[name.toLowerCase()] = value;
    }
    return headers;
}

function parseBody(init?: RequestInit): unknown {
    if (init?.body === undefined || init.body === null) return undefined;
    return JSON.parse(String(init.body));
}

/**
 * Check the headers a recorded request carried, plus the one thing the corpus
 * records about credentials.
 *
 * The corpus never records a credential value, only which kind was presented,
 * so the only credential assertion available here is that a request recorded
 * behind a Context carrier went out carrying one. Absence checks belong to the
 * driver that cares about them: a client may legitimately present a credential
 * where the recording presented none, and `/v1/health` answering either way is
 * the corpus's own point.
 */
function assertHeaders(request: EmittedRequest, recorded: WireCase): void {
    for (const [name, value] of Object.entries(recorded.request.headers)) {
        const actual = request.headers[name.toLowerCase()];
        if (actual !== value) {
            throw new Error(
                `${recorded.id}: recorded header ${name}: ${value}, client sent ${actual ?? '(nothing)'}`,
            );
        }
    }
    if (
        recorded.auth.credential === 'context-token' &&
        request.headers[CONTEXT_TOKEN_HEADER] === undefined
    ) {
        throw new Error(
            `${recorded.id}: recorded behind a Context carrier, but the client sent no ${CONTEXT_TOKEN_HEADER}`,
        );
    }
}

/**
 * A transport that will answer exactly the named corpus cases, once each.
 *
 * The cases come from any recordings keyed by id: the wire corpus, or one of
 * the integration scenarios the conformance server carries.
 *
 * Cases are matched by canonical request rather than by call order, so a driver
 * whose client fans several requests out in parallel is served correctly
 * without the test having to predict which one lands first.
 */
export class ReplayTransport {
    private readonly _pending: Map<string, WireCase[]> = new Map();
    private readonly _expected: WireCase[];
    private readonly _options: ReplayTransportOptions;
    /** Requests the client emitted, in the order the transport saw them. */
    readonly emitted: EmittedRequest[] = [];

    constructor(
        corpus: Pick<LoadedWireCorpus, 'byId'>,
        caseIds: readonly string[],
        options: ReplayTransportOptions | RequestAssertion = {},
    ) {
        this._options =
            typeof options === 'function'
                ? { assertRequest: options }
                : options;
        this._expected = caseIds.map((id) => {
            const recorded = corpus.byId.get(id);
            if (!recorded) {
                throw new Error(`no corpus case with the id ${id}`);
            }
            return recorded;
        });
        for (const recorded of this._expected) {
            const key = matchKey(
                recorded.request.method,
                recorded.request.path,
                recorded.request.body,
            );
            const bucket = this._pending.get(key);
            if (bucket) bucket.push(recorded);
            else this._pending.set(key, [recorded]);
        }
    }

    /** The `fetchImpl` to hand the client under test. */
    readonly fetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith(REPLAY_BASE_URL)) {
            throw new Error(`request left the replay base URL: ${url}`);
        }
        const target = url.slice(REPLAY_BASE_URL.length);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = parseBody(init);
        const key = matchKey(method, target, body);

        const bucket = this._pending.get(key);
        const recorded = this._options.repeatable
            ? bucket?.[0]
            : bucket?.shift();
        if (!recorded || !bucket) {
            throw new Error(this._noMatch(method, target, body));
        }
        if (!this._options.repeatable && bucket.length === 0) {
            this._pending.delete(key);
        }

        const request: EmittedRequest = {
            body,
            caseId: recorded.id,
            headers: lowercaseHeaders(init),
            method,
            signal: init?.signal ?? undefined,
            target,
        };
        assertHeaders(request, recorded);
        this._options.assertRequest?.(request);
        this.emitted.push(request);

        await this._options.beforeRespond?.(request);

        return new Response(JSON.stringify(recorded.response.body), {
            headers: recorded.response.headers,
            status: recorded.response.status,
        });
    };

    /**
     * Fail unless every expected case was emitted: exactly once by default, and
     * at least once when the transport is repeatable.
     *
     * A driver that stopped making one of its requests is as much a regression
     * as one that started making a wrong request, and only this catches it.
     */
    assertEveryCaseEmitted(): void {
        const missing = this._options.repeatable
            ? this._expected
                  .filter(
                      (entry) =>
                          !this.emitted.some(
                              (request) => request.caseId === entry.id,
                          ),
                  )
                  .map((entry) => entry.id)
            : [...this._pending.values()].flat().map((entry) => entry.id);
        if (missing.length > 0) {
            throw new Error(
                `the client never emitted the request recorded by: ${missing.join(', ')}`,
            );
        }
    }

    /** How many times the client emitted the request one case recorded. */
    countFor(caseId: string): number {
        return this.emitted.filter((request) => request.caseId === caseId)
            .length;
    }

    /** The recorded response body for one of this transport's cases. */
    recorded(caseId: string): WireCase {
        const found = this._expected.find((entry) => entry.id === caseId);
        if (!found)
            throw new Error(`${caseId} is not expected by this transport`);
        return found;
    }

    /**
     * Report a request nothing expected, beside the closest thing that was.
     *
     * The nearest case is the one sharing this path, and any outstanding case
     * otherwise. It is a hint for reading the failure, not a claim about what
     * the client meant to send.
     */
    private _noMatch(method: string, target: string, body: unknown): string {
        const outstanding = [...this._pending.values()].flat();
        const path = target.split('?')[0];
        const nearest =
            outstanding.find((entry) => entry.request.path === path) ??
            outstanding[0];
        const lines = [
            `the client emitted a request no expected corpus case recorded:`,
            `  emitted:  ${method} ${target}`,
            `  body:     ${body === undefined ? '(none)' : JSON.stringify(body)}`,
        ];
        if (nearest) {
            lines.push(
                `  nearest:  ${nearest.request.method} ${nearest.request.path}   (${nearest.id})`,
                `  body:     ${nearest.request.body === undefined ? '(none)' : JSON.stringify(nearest.request.body)}`,
            );
        } else {
            lines.push('  every expected case has already been served');
        }
        return lines.join('\n');
    }
}
