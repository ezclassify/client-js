/**
 * The circuit breaker and how it closes again.
 *
 * A transport failure marks the server unreachable and every later request is
 * refused without touching the wire. Two things reopen it: the health poll
 * where it is running, and a single request let through after a cooldown, which
 * happens whether or not the poll is on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

function ok(): Response {
    return mockResponse(200, JSON.stringify({ ok: true }));
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

describe('circuit breaker', () => {
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

    /** A connected client whose first wire failure opens the breaker. */
    async function trippedClient(
        heartbeat: boolean,
        options: { timeout?: number } = {},
    ): Promise<EzClassifyClient> {
        fetchMock.mockResolvedValueOnce(ok());
        const c = await EzClassifyClient.connect(BASE_URL, {
            disableCache: true,
            heartbeat,
            ...options,
        });
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await grab(() => c._request('GET', '/v1/ctx'));
        expect(c.connected).toBe(false);
        fetchMock.mockReset();
        return c;
    }

    describe('with the health poll off', () => {
        it('refuses a request that arrives during the cooldown', async () => {
            const c = await trippedClient(false);
            await vi.advanceTimersByTimeAsync(4_000);

            const err = await grab(() => c._request('GET', '/v1/ctx'));
            expect(err.code).toBe(ErrorCodes.UNREACHABLE);
            expect(fetchMock).not.toHaveBeenCalled();
            c.destroy();
        });

        it('lets one request test the wire once the cooldown has passed', async () => {
            const c = await trippedClient(false);
            fetchMock.mockResolvedValue(ok());
            await vi.advanceTimersByTimeAsync(5_000);

            await expect(c._request('GET', '/v1/ctx')).resolves.toEqual({
                ok: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            c.destroy();
        });

        it('is closed by a successful probe, so later requests go straight out', async () => {
            const c = await trippedClient(false);
            fetchMock.mockResolvedValue(ok());
            await vi.advanceTimersByTimeAsync(5_000);
            await c._request('GET', '/v1/ctx');

            expect(c.connected).toBe(true);
            await expect(c._request('GET', '/v1/ctx/next')).resolves.toEqual({
                ok: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
            c.destroy();
        });

        // Once the cooldown elapses, one request probes the server; a server
        // that is still down must not take the whole concurrent burst.
        it('lets exactly one request of a concurrent burst reach the wire', async () => {
            const c = await trippedClient(false);
            let release: (r: Response) => void = () => {};
            fetchMock.mockImplementation(
                () =>
                    new Promise<Response>((resolve) => {
                        release = resolve;
                    }),
            );
            await vi.advanceTimersByTimeAsync(5_000);

            const probe = c._request('GET', '/v1/ctx');
            const refused = await grab(() =>
                c._request('GET', '/v1/ctx/other'),
            );
            expect(refused.code).toBe(ErrorCodes.UNREACHABLE);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            release(ok());
            await expect(probe).resolves.toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            c.destroy();
        });

        // A probe against a server that accepts the connection and answers
        // nothing times out, and that timeout has to re-arm the cooldown, or
        // every later request hangs for the full timeout.
        it('re-arms the cooldown when the probe times out', async () => {
            const c = await trippedClient(false, { timeout: 10 });
            fetchMock.mockImplementation(
                (_url: string, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener(
                            'abort',
                            () =>
                                reject(
                                    new DOMException('aborted', 'AbortError'),
                                ),
                            { once: true },
                        );
                    }),
            );
            await vi.advanceTimersByTimeAsync(5_000);

            const pending = grab(() => c._request('GET', '/v1/ctx'));
            await vi.advanceTimersByTimeAsync(20);
            expect((await pending).code).toBe(ErrorCodes.TIMEOUT);

            const refused = await grab(() => c._request('GET', '/v1/ctx'));
            expect(refused.code).toBe(ErrorCodes.UNREACHABLE);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            c.destroy();
        });

        it('re-arms the cooldown when the probe fails again', async () => {
            const c = await trippedClient(false);
            fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await vi.advanceTimersByTimeAsync(5_000);
            const probe = await grab(() => c._request('GET', '/v1/ctx'));
            expect(probe.code).toBe(ErrorCodes.NETWORK);

            await vi.advanceTimersByTimeAsync(4_000);
            const refused = await grab(() => c._request('GET', '/v1/ctx'));
            expect(refused.code).toBe(ErrorCodes.UNREACHABLE);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            fetchMock.mockResolvedValue(ok());
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(c._request('GET', '/v1/ctx')).resolves.toEqual({
                ok: true,
            });
            c.destroy();
        });
    });

    describe('with the health poll running', () => {
        it('refuses a request that arrives during the cooldown', async () => {
            const c = await trippedClient(true);
            // A fetch is ready and would answer: the point is that no request
            // is allowed to reach it while the cooldown is still running.
            fetchMock.mockResolvedValue(ok());
            await vi.advanceTimersByTimeAsync(4_000);

            const err = await grab(() => c._request('GET', '/v1/ctx'));
            expect(err.code).toBe(ErrorCodes.UNREACHABLE);
            expect(fetchMock).not.toHaveBeenCalled();
            c.destroy();
        });

        // The poll backs off to a minute, so the cooldown probe runs even while
        // it is on; otherwise a client could keep refusing requests for that
        // long after the server was healthy again.
        it('still lets one request test the wire once the cooldown has passed', async () => {
            const c = await trippedClient(true);
            fetchMock.mockResolvedValue(ok());
            await vi.advanceTimersByTimeAsync(5_000);

            await expect(c._request('GET', '/v1/ctx')).resolves.toEqual({
                ok: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(c.connected).toBe(true);
            c.destroy();
        });
    });
});
