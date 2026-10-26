/**
 * Failure classification.
 *
 * Covers the code each client-originated failure carries, which failures are
 * allowed to open the circuit breaker, and the discrimination between a 404
 * that means "absent" and a 404 that means "the request never reached the
 * router".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes, isDenialShapedBody } from '../src/errors';
import * as publicApi from '../src/index';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

/**
 * A fetch that never settles until its request is aborted. It rejects on an
 * already-aborted signal too, which is what a conforming fetch does and what
 * the client relies on when the caller aborts before the request goes out.
 */
function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const fail = (): void =>
            reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
    });
}

async function grab(fn: () => Promise<unknown>): Promise<EzClassifyError> {
    try {
        await fn();
    } catch (e) {
        if (e instanceof EzClassifyError) return e;
        throw e;
    }
    throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
// isDenialShapedBody
// ---------------------------------------------------------------------------
describe('isDenialShapedBody', () => {
    it('matches the constant denial body', () => {
        expect(isDenialShapedBody({ error: 'not_found' })).toBe(true);
    });

    it('rejects a not-found body that names the missing thing', () => {
        expect(isDenialShapedBody({ error: 'not_found', id: 'scheme-a' })).toBe(
            false,
        );
    });

    it('rejects a different error value', () => {
        expect(isDenialShapedBody({ error: 'forbidden' })).toBe(false);
    });

    it('rejects a non-object body', () => {
        expect(isDenialShapedBody('not_found')).toBe(false);
        expect(isDenialShapedBody(null)).toBe(false);
        expect(isDenialShapedBody(undefined)).toBe(false);
        expect(isDenialShapedBody([{ error: 'not_found' }])).toBe(false);
    });

    it('is reachable from the package entry, so consumers can run it too', () => {
        expect(publicApi.isDenialShapedBody).toBe(isDenialShapedBody);
    });
});

describe('failure classification', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
        vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    function client(
        options?: ConstructorParameters<typeof EzClassifyClient>[1],
    ): EzClassifyClient {
        return new EzClassifyClient(BASE_URL, {
            contextId: 'test-context',
            contextVersion: '1.0.0',
            disableCache: true,
            ...options,
        });
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------
    describe('timeout', () => {
        it('carries TIMEOUT, not the transport code', async () => {
            const c = client({ timeout: 10, fetchImpl: hangingFetch });
            const pending = grab(() => c._request('GET', '/v1/ctx'));
            await vi.advanceTimersByTimeAsync(20);
            const err = await pending;
            expect(err.code).toBe(ErrorCodes.TIMEOUT);
            expect(err.message).toMatch(/timed out after 10ms/);
            expect(err.status).toBeUndefined();
        });

        it('leaves the connection flag alone', async () => {
            const c = client({ timeout: 10, fetchImpl: hangingFetch });
            (c as never as { _connected: boolean })._connected = true;
            const pending = grab(() => c._request('GET', '/v1/ctx'));
            await vi.advanceTimersByTimeAsync(20);
            await pending;
            expect(c.connected).toBe(true);
        });

        it('does not open the circuit breaker for the next request', async () => {
            const calls: string[] = [];
            let hang = true;
            const c = client({
                timeout: 10,
                fetchImpl: (url: string, init: RequestInit) => {
                    calls.push(url as string);
                    if (hang) return hangingFetch(url, init);
                    return Promise.resolve(
                        mockResponse(200, JSON.stringify({ ok: true })),
                    );
                },
            });
            const cState = c as never as {
                _connected: boolean;
                _everConnected: boolean;
            };
            cState._connected = true;
            cState._everConnected = true;

            const pending = grab(() => c._request('GET', '/v1/ctx'));
            await vi.advanceTimersByTimeAsync(20);
            await pending;

            hang = false;
            await expect(c._request('GET', '/v1/ctx/next')).resolves.toEqual({
                ok: true,
            });
            expect(calls).toHaveLength(2);
        });
    });

    describe('external abort', () => {
        it('carries ABORTED', async () => {
            const c = client({ fetchImpl: hangingFetch });
            const controller = new AbortController();
            const pending = grab(() =>
                c.scheme.process('X', { signal: controller.signal }),
            );
            controller.abort();
            const err = await pending;
            expect(err.code).toBe(ErrorCodes.ABORTED);
            expect(err.message).toMatch(/Request aborted/);
        });

        it('leaves the connection flag alone', async () => {
            const c = client({ fetchImpl: hangingFetch });
            (c as never as { _connected: boolean })._connected = true;
            const controller = new AbortController();
            const pending = grab(() =>
                c.scheme.process('X', { signal: controller.signal }),
            );
            controller.abort();
            await pending;
            expect(c.connected).toBe(true);
        });
    });

    describe('a deadline carried on a signal', () => {
        it('is a timeout, not the caller aborting', async () => {
            const c = client({ fetchImpl: hangingFetch });
            const deadline = new AbortController();
            const pending = grab(() =>
                c.scheme.process('X', { signal: deadline.signal }),
            );
            deadline.abort(
                new DOMException('The operation timed out.', 'TimeoutError'),
            );

            const err = await pending;
            expect(err.code).toBe(ErrorCodes.TIMEOUT);
            expect(err.message).toMatch(/timed out/);
        });

        it("is a timeout on connect()'s own health probe", async () => {
            // connect() gives the probe an AbortSignal.timeout(5_000). Fake
            // timers do not drive that signal, so the deadline is stood in for
            // by a controller aborting the same way the real one does.
            const deadline = new AbortController();
            const timeoutSignal = vi
                .spyOn(AbortSignal, 'timeout')
                .mockReturnValue(deadline.signal);

            const pending = grab(() =>
                EzClassifyClient.connect(BASE_URL, {
                    fetchImpl: hangingFetch,
                    heartbeat: false,
                }),
            );
            deadline.abort(
                new DOMException('The operation timed out.', 'TimeoutError'),
            );

            const err = await pending;
            expect(err.code).toBe(ErrorCodes.TIMEOUT);
            timeoutSignal.mockRestore();
        });
    });

    describe('transport failure', () => {
        it('carries NETWORK and clears the connection flag', async () => {
            fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
            const c = client();
            (c as never as { _connected: boolean })._connected = true;
            const err = await grab(() => c._request('GET', '/v1/ctx'));
            expect(err.code).toBe(ErrorCodes.NETWORK);
            expect(c.connected).toBe(false);
        });
    });

    describe('circuit breaker', () => {
        it('carries UNREACHABLE', async () => {
            const c = client();
            const state = c as never as {
                _connected: boolean;
                _everConnected: boolean;
                _unreachableSince: number;
            };
            state._everConnected = true;
            state._connected = false;
            // The failure that opened the breaker just happened, so the
            // cooldown before a request may test the wire is still running.
            state._unreachableSince = Date.now();
            const err = await grab(() => c._request('GET', '/v1/ctx'));
            expect(err.code).toBe(ErrorCodes.UNREACHABLE);
        });
    });

    // -----------------------------------------------------------------------
    // Non-2xx
    // -----------------------------------------------------------------------
    describe('non-2xx responses', () => {
        it('keeps the code the server put in the body', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    409,
                    JSON.stringify({ code: 'SCHEME_CONFLICT', error: 'clash' }),
                ),
            );
            const err = await grab(() => client()._request('GET', '/v1/ctx'));
            expect(err.code).toBe('SCHEME_CONFLICT');
        });

        it('falls back to HTTP when the body carries no code', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(500, JSON.stringify({ error: 'boom' })),
            );
            const err = await grab(() => client()._request('GET', '/v1/ctx'));
            expect(err.code).toBe(ErrorCodes.HTTP);
            expect(err.status).toBe(500);
        });

        it('quotes a short unstructured body in the message', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(502, 'upstream refused the connection'),
            );
            const err = await grab(() => client()._request('GET', '/v1/ctx'));
            expect(err.message).toBe(
                'API error 502 from GET /v1/ctx: upstream refused the connection',
            );
        });

        // An exception message travels further than the response did, so a
        // long body stays out of it.
        it('truncates a long unstructured body and points at the parsed one', async () => {
            const body = 'x'.repeat(5_000);
            fetchMock.mockResolvedValue(mockResponse(502, body));
            const err = await grab(() => client()._request('GET', '/v1/ctx'));
            expect(err.message.length).toBeLessThan(300);
            expect(err.message).toContain(
                '[body truncated, see EzClassifyError.body]',
            );
            // Nothing is lost: the parsed body still carries all of it.
            expect(err.body).toBe(body);
        });

        it('reserves INVALID_INPUT for genuine input validation', () => {
            const err = new EzClassifyClient(BASE_URL);
            expect(() => err.scheme.getScheme()).toThrow(
                expect.objectContaining({ code: ErrorCodes.INVALID_INPUT }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // A 2xx the contract does not allow
    // -----------------------------------------------------------------------
    describe('malformed success', () => {
        it.each([
            ['an empty body', ''],
            ['a body that is not JSON', '<html>gateway</html>'],
        ])(
            'carries MALFORMED_RESPONSE for %s, not the caller-input code',
            async (_name, body) => {
                fetchMock.mockResolvedValue(mockResponse(200, body));
                const err = await grab(() =>
                    client()._request('GET', '/v1/ctx'),
                );
                expect(err.code).toBe(ErrorCodes.MALFORMED_RESPONSE);
                expect(err.message).toContain('GET /v1/ctx');
                expect(err.status).toBeUndefined();
            },
        );
    });

    // -----------------------------------------------------------------------
    // Denial-shaped 404
    // -----------------------------------------------------------------------
    describe('denial-shaped 404', () => {
        it('is flagged possiblyUnauthenticated when a token is configured', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(404, JSON.stringify({ error: 'not_found' })),
            );
            const err = await grab(() =>
                client({ auth: { token: 'token' } })._request('GET', '/v1/ctx'),
            );
            expect(err.possiblyUnauthenticated).toBe(true);
            expect(err.status).toBe(404);
        });

        it('says to check the credentials before blaming the route', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(404, JSON.stringify({ error: 'not_found' })),
            );
            const err = await grab(() =>
                client({ auth: { token: 'token' } })._request('GET', '/v1/ctx'),
            );
            expect(err.message).toMatch(
                /check the caller credentials before assuming the route or resource is missing/,
            );
        });

        it('is flagged when the caller supplied the Authorization header itself', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(404, JSON.stringify({ error: 'not_found' })),
            );
            const err = await grab(() =>
                client({ headers: { Authorization: 'Bearer own' } })._request(
                    'GET',
                    '/v1/ctx',
                ),
            );
            expect(err.possiblyUnauthenticated).toBe(true);
        });

        it('is not flagged when no caller credential is in play', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(404, JSON.stringify({ error: 'not_found' })),
            );
            const err = await grab(() => client()._request('GET', '/v1/ctx'));
            expect(err.possiblyUnauthenticated).toBeUndefined();
        });

        it('is not flagged for a 404 that names the missing resource', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'not_found', id: 'scheme-a' }),
                ),
            );
            const err = await grab(() =>
                client({ auth: { token: 'token' } })._request('GET', '/v1/ctx'),
            );
            expect(err.possiblyUnauthenticated).toBeUndefined();
            expect(err.message).not.toMatch(/check the caller credentials/);
        });
    });
});
