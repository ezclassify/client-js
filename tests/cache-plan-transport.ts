/**
 * The counting replay transport the cache conformance plans run through.
 *
 * It answers each request with the recorded response of the corpus case the
 * request matches and counts requests per case. Matching is the contract's: the
 * method, the path and the canonical body as recorded, with two allowances. The
 * `{version}` path segment may carry the binding's version, the resolved
 * version, or be absent when a signed carrier supplies the version, and query
 * parameters match as a set.
 *
 * Beyond matching it provides what the plans need that a recording cannot: a
 * response gate that holds a request in flight, scripted responses derived from
 * recorded bytes (a malformed 200, the denial-shaped 404, a moved resolved
 * version), and one request shape the corpus has no recording for, an explicit
 * null member, which is answered with the base case's recorded response.
 */

import { matchKey } from '@ezclassify/conformance-server';
import type { LoadedWireCorpus, WireCase } from './wire-corpus';

/** Base URL the plan clients are pointed at. Never dialed. */
export const PLAN_BASE_URL = 'https://replay.invalid';

/** Header the runtime stamps every Context response with. */
const RESOLVED_VERSION_HEADER = 'x-ezclassify-resolved-version';

/** The request variant the corpus has no recording for. */
export interface NullVariant {
    kind: 'explicitNullMember';
    member: string;
}

/** One request the client put on the wire, as the transport saw it. */
export interface PlanRequest {
    /** Corpus case the request matched, or the base case of a null variant. */
    caseId: string;
    /** Set when the request is the base case with one member sent as null. */
    variant?: NullVariant;
    /** The signal the client gave this request. */
    signal?: AbortSignal;
    /** The signal fired before the transport answered. */
    aborted: boolean;
}

/** A synthetic answer queued for the next request matching a case. */
type Scripted =
    | { kind: 'malformed'; caseId: string; removeMembers: string[] }
    | { kind: 'denial'; caseId: string };

/** Requests held in flight for one gated case. */
interface Gate {
    held: Array<{ request: PlanRequest; release: () => void }>;
}

/**
 * Recorded case ids the transport never serves in the ordinary way: the denial
 * recordings share their request with the open-deployment case, and only a
 * scripted denial replays them.
 */
function servable(entry: WireCase): boolean {
    return (
        !entry.id.startsWith('denial.') && !entry.id.startsWith('route-miss.')
    );
}

/** Replace the version segment of a Context path with a wildcard. */
function eraseVersion(path: string, template: string | undefined): string {
    if (!template?.includes('{version}')) return path;
    const [pathname, query] = splitTarget(path);
    const segments = pathname.split('/');
    const index = template.split('/').indexOf('{version}');
    if (index === -1 || index >= segments.length) return path;
    segments[index] = '*';
    return joinTarget(segments.join('/'), query);
}

function splitTarget(target: string): [string, string] {
    const at = target.indexOf('?');
    return at === -1 ? [target, ''] : [target.slice(0, at), target.slice(at)];
}

function joinTarget(pathname: string, query: string): string {
    return `${pathname}${query}`;
}

/** Remove the member at a JSON pointer, which the recording must have. */
function removePointer(body: unknown, pointer: string): void {
    const names = pointer.split('/').slice(1);
    let holder = body as Record<string, unknown> | undefined;
    for (const name of names.slice(0, -1)) {
        holder = holder?.[name] as Record<string, unknown> | undefined;
    }
    const last = names[names.length - 1];
    if (
        holder === undefined ||
        last === undefined ||
        typeof holder !== 'object' ||
        !(last in holder)
    ) {
        throw new Error(
            `${pointer} is not a member of the recorded response, so removing it is not derived from recorded bytes`,
        );
    }
    delete holder[last];
}

export class PlanTransport {
    private readonly _index = new Map<string, WireCase>();
    private readonly _scripted: Scripted[] = [];
    private readonly _gates = new Map<string, Gate>();
    private readonly _denial: WireCase;
    private _movedTo: string | undefined;
    private _markedAt = 0;

    /** Every request the client emitted, in order. */
    readonly requests: PlanRequest[] = [];
    /** Requests no recording matched. A plan that has any fails. */
    readonly unmatched: string[] = [];

    constructor(corpus: LoadedWireCorpus, denialCaseId: string) {
        const denial = corpus.byId.get(denialCaseId);
        if (!denial) throw new Error(`no corpus case ${denialCaseId}`);
        this._denial = denial;
        for (const entry of corpus.cases.filter(servable)) {
            const key = matchKey(
                entry.request.method,
                eraseVersion(entry.request.path, entry.request.pathTemplate),
                entry.request.body,
            );
            if (this._index.has(key)) {
                throw new Error(
                    `${entry.id} and ${this._index.get(key)?.id} record the same request`,
                );
            }
            this._index.set(key, entry);
        }
    }

    /** Start counting here: everything before it was connect traffic. */
    mark(): void {
        this._markedAt = this.requests.length;
    }

    /** Requests emitted since {@link mark}. */
    private get _counted(): PlanRequest[] {
        return this.requests.slice(this._markedAt);
    }

    /** How many counted requests matched a case, or a case's null variant. */
    countFor(caseId: string, variant?: NullVariant): number {
        return this._counted.filter(
            (request) =>
                request.caseId === caseId &&
                request.variant?.member === variant?.member &&
                request.variant?.kind === variant?.kind,
        ).length;
    }

    /** The most recent counted request for a case. */
    latestFor(caseId: string): PlanRequest | undefined {
        return this._counted
            .filter((request) => request.caseId === caseId)
            .at(-1);
    }

    /** Answer the next request matching a case with its record minus members. */
    scriptMalformed(caseId: string, removeMembers: string[]): void {
        this._scripted.push({ kind: 'malformed', caseId, removeMembers });
    }

    /** Answer the next request matching a case with the denial recording. */
    scriptDenial(caseId: string): void {
        this._scripted.push({ kind: 'denial', caseId });
    }

    /** Make every later response name this resolved Context version. */
    moveResolvedVersion(version: string): void {
        this._movedTo = version;
    }

    /** Hold every later request matching a case until {@link release}. */
    gate(caseId: string): void {
        if (!this._gates.has(caseId)) this._gates.set(caseId, { held: [] });
    }

    /** Resolve once a request for the gated case is held at the transport. */
    async untilHeld(caseId: string): Promise<void> {
        for (let attempt = 0; attempt < 500; attempt += 1) {
            if ((this._gates.get(caseId)?.held.length ?? 0) > 0) return;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error(`no request for ${caseId} reached the gate`);
    }

    /**
     * Answer the requests held for a case, and stop holding it: a gate holds
     * the requests that arrive before its release, not the ones after.
     */
    release(caseId: string): void {
        const gate = this._gates.get(caseId);
        if (!gate) throw new Error(`${caseId} is not gated`);
        this._gates.delete(caseId);
        const held = gate.held.splice(0);
        for (const entry of held) {
            if (!entry.request.aborted) entry.release();
        }
    }

    /** The `fetchImpl` to hand the client under test. */
    readonly fetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith(PLAN_BASE_URL)) {
            throw new Error(`request left the replay base URL: ${url}`);
        }
        const target = url.slice(PLAN_BASE_URL.length);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body =
            init?.body === undefined || init.body === null
                ? undefined
                : (JSON.parse(String(init.body)) as unknown);

        const found = this._match(method, target, body);
        if (!found) {
            const description = `${method} ${target} ${body === undefined ? '' : JSON.stringify(body)}`;
            this.unmatched.push(description);
            throw new Error(`no recorded case matches ${description}`);
        }

        const request: PlanRequest = {
            caseId: found.entry.id,
            ...(found.variant ? { variant: found.variant } : {}),
            signal: init?.signal ?? undefined,
            aborted: false,
        };
        this.requests.push(request);
        init?.signal?.addEventListener(
            'abort',
            () => {
                request.aborted = true;
            },
            { once: true },
        );

        const gate = this._gates.get(found.entry.id);
        if (gate) await this._hold(gate, request, init?.signal ?? undefined);

        return this._answer(found.entry);
    };

    /** Park a request at the gate until it is released or its signal fires. */
    private _hold(
        gate: Gate,
        request: PlanRequest,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            gate.held.push({ request, release: resolve });
            const onAbort = (): void =>
                reject(new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /** The recorded case a request is, or its explicit-null base case. */
    private _match(
        method: string,
        target: string,
        body: unknown,
    ): { entry: WireCase; variant?: NullVariant } | undefined {
        const direct = this._lookup(method, target, body);
        if (direct) return { entry: direct };
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
            for (const [member, value] of Object.entries(body)) {
                if (value !== null) continue;
                const { [member]: _removed, ...rest } = body as Record<
                    string,
                    unknown
                >;
                const base = this._lookup(method, target, rest);
                if (base) {
                    return {
                        entry: base,
                        variant: { kind: 'explicitNullMember', member },
                    };
                }
            }
        }
        return undefined;
    }

    /**
     * Find the recording for a request, trying the exact path, the path with
     * the version segment absent, then the path with the version segment named.
     * Absent is tried before named so a carrier-defaulted `/scheme` is not read
     * as a version called "scheme".
     */
    private _lookup(
        method: string,
        target: string,
        body: unknown,
    ): WireCase | undefined {
        const exact = this._index.get(matchKey(method, target, body));
        if (exact) return exact;
        const [pathname, query] = splitTarget(target);
        const segments = pathname.split('/');
        // ['', 'v1', 'ctx', id, ...rest]
        if (segments[1] !== 'v1' || segments[2] !== 'ctx') return undefined;
        const absent = [...segments.slice(0, 4), '*', ...segments.slice(4)];
        const named =
            segments.length > 4
                ? [...segments.slice(0, 4), '*', ...segments.slice(5)]
                : undefined;
        for (const candidate of [absent, named]) {
            if (!candidate) continue;
            const hit = this._index.get(
                matchKey(method, joinTarget(candidate.join('/'), query), body),
            );
            if (hit) return hit;
        }
        return undefined;
    }

    /** Build the response for a matched case, honoring scripted answers. */
    private _answer(entry: WireCase): Response {
        const scripted = this._takeScripted(entry.id);
        let source = entry;
        let body: unknown = structuredClone(entry.response.body);
        if (scripted?.kind === 'denial') {
            source = this._denial;
            body = structuredClone(this._denial.response.body);
        } else if (scripted?.kind === 'malformed') {
            for (const pointer of scripted.removeMembers) {
                removePointer(body, pointer);
            }
        }

        const headers: Record<string, string> = { ...source.response.headers };
        if (this._movedTo !== undefined && scripted?.kind !== 'denial') {
            this._retarget(body, headers, entry);
        }
        return new Response(JSON.stringify(body), {
            headers,
            status: source.response.status,
        });
    }

    private _takeScripted(caseId: string): Scripted | undefined {
        const at = this._scripted.findIndex((item) => item.caseId === caseId);
        return at === -1 ? undefined : this._scripted.splice(at, 1)[0];
    }

    /**
     * Rewrite the resolved Context version wherever the recorded bytes name it:
     * the response header, the envelope's resolution, and the version of a
     * Context description.
     */
    private _retarget(
        body: unknown,
        headers: Record<string, string>,
        entry: WireCase,
    ): void {
        const to = this._movedTo as string;
        const recorded = entry.response.headers[RESOLVED_VERSION_HEADER];
        if (recorded !== undefined) headers[RESOLVED_VERSION_HEADER] = to;
        if (body === null || typeof body !== 'object') return;
        const record = body as Record<string, unknown>;
        const resolution = record['resolution'] as
            | {
                  resolvedVersion?: string;
                  artifacts?: Array<Record<string, string>>;
              }
            | undefined;
        if (resolution?.resolvedVersion !== undefined) {
            resolution.resolvedVersion = to;
            for (const artifact of resolution.artifacts ?? []) {
                if (artifact['kind'] === 'context') artifact['version'] = to;
            }
        }
        if (
            recorded !== undefined &&
            'schemes' in record &&
            record['version'] === recorded
        ) {
            record['version'] = to;
        }
    }
}
