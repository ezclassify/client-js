/**
 * The background health poll.
 *
 * A connected client polls `/v1/health` so it can notice the server coming
 * back. That poll must not keep a Node process alive, and a host that builds a
 * client per request must be able to turn it off outright.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

function health(): Response {
    return mockResponse(200, JSON.stringify({ status: 'ok' }));
}

describe('heartbeat', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
        fetchMock.mockResolvedValue(health());
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    it('schedules a poll after connect', async () => {
        const c = await EzClassifyClient.connect(BASE_URL);
        expect(
            (c as never as { _heartbeatTimer: unknown })._heartbeatTimer,
        ).not.toBeNull();
        c.destroy();
    });

    it('does not hold the event loop open', async () => {
        const c = await EzClassifyClient.connect(BASE_URL);
        const timer = (
            c as never as { _heartbeatTimer: { hasRef: () => boolean } }
        )._heartbeatTimer;
        // The suite runs on Node, where the Timeout handle carries hasRef and
        // unref is the thing under test. A guarded assertion here would pass
        // by skipping itself.
        expect(typeof timer.hasRef).toBe('function');
        expect(timer.hasRef()).toBe(false);
        c.destroy();
    });

    it('never starts when heartbeat is off', async () => {
        const c = await EzClassifyClient.connect(BASE_URL, {
            heartbeat: false,
        });
        expect(
            (c as never as { _heartbeatTimer: unknown })._heartbeatTimer,
        ).toBeNull();
        c.destroy();
    });

    it('sends no health poll when heartbeat is off', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const c = await EzClassifyClient.connect(BASE_URL, {
            heartbeat: false,
        });
        // One call for connect's own probe, and nothing after.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        c.destroy();
    });

    it('keeps polling when heartbeat is left at its default', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const c = await EzClassifyClient.connect(BASE_URL);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        c.destroy();
    });

    it('takes a computed boolean, which is how a host decides this', async () => {
        // `heartbeat: isBrowser` is the natural spelling for the server
        // renderers this option exists for, and a literal-false type rejects a
        // value that is only known at runtime.
        const isBrowser: boolean = typeof globalThis.document !== 'undefined';
        const c = await EzClassifyClient.connect(BASE_URL, {
            heartbeat: isBrowser,
        });
        expect(
            (c as never as { _heartbeatTimer: unknown })._heartbeatTimer,
        ).toBeNull();
        c.destroy();
    });
});
