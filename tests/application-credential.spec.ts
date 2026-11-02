import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

const header = 'x-ezclassify-application-grant';
const credential = 'opaque-application-credential';
const originalFetch = globalThis.fetch;
type Options = ConstructorParameters<typeof EzClassifyClient>[1];

function client(options?: Options) {
    return new EzClassifyClient('https://runtime.example', {
        heartbeat: false,
        disableCache: true,
        ...options,
    });
}

describe('application credential transport', () => {
    let transport: ReturnType<typeof stubFetch>;
    beforeEach(() => {
        transport = stubFetch();
        transport.mockResolvedValue(
            mockResponse(200, JSON.stringify({ ok: true })),
        );
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it.each([
        header,
        'X-EzClassify-Application-Grant',
        'X-EZCLASSIFY-APPLICATION-GRANT',
    ])(
        'recognizes %s and keeps it off probes and non-Context paths',
        async (name) => {
            const c = client({
                headers: { [name]: credential, 'X-Request-Id': 'request' },
            });
            await c._request('GET', '/v1/ctx');
            const first = transport.mock.calls[0]![1]!.headers as Record<
                string,
                string
            >;
            expect(first[name]).toBe(credential);
            for (const path of ['/v1/health', '/v1/version', '/v1/ctx-other']) {
                await c._request('GET', path);
                const sent = transport.mock.lastCall![1]!.headers as Record<
                    string,
                    string
                >;
                expect(
                    Object.keys(sent).some(
                        (key) => key.toLowerCase() === header,
                    ),
                ).toBe(false);
                expect(sent['X-Request-Id']).toBe('request');
            }
        },
    );

    it.each([
        { headers: { [header]: credential, Authorization: 'Bearer identity' } },
        { headers: { [header]: credential, authorization: 'Bearer identity' } },
        {
            headers: {
                [header]: credential,
                'X-EzClassify-Context-Token': 'context',
            },
        },
        {
            headers: {
                [header]: credential,
                'x-ezclassify-context-token': 'context',
            },
        },
        { headers: { [header]: credential }, auth: { token: 'identity' } },
        {
            headers: { [header]: credential },
            auth: { token: () => 'identity' },
        },
        { headers: { [header]: credential }, contextToken: 'context' },
        { headers: { [header]: credential }, contextToken: () => 'context' },
        {
            headers: {
                [header]: credential,
                'X-EzClassify-Application-Grant': credential,
            },
        },
    ])(
        'refuses mixed or duplicate credentials before sending a request',
        (options) => {
            expect(() => client(options)).toThrow(/application credential/);
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it.each(['', '   '])(
        'refuses an empty credential without a request',
        (value) => {
            expect(() => client({ headers: { [header]: value } })).toThrow(
                /nonempty string/,
            );
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it.each([
        { contextId: '.' },
        { contextId: '..' },
        { contextId: 'mission', contextVersion: '.' },
        { contextId: 'mission', contextVersion: '..' },
    ])(
        'keeps URL normalization from moving credentials outside Context paths',
        (binding) => {
            for (const authentication of [
                { headers: { [header]: credential } },
                { contextToken: 'opaque-context-token' },
            ]) {
                expect(() => client({ ...binding, ...authentication })).toThrow(
                    /Context path segment/,
                );
            }
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it('takes one immutable copy of the supplied header configuration', async () => {
        const headers = { [header]: credential };
        const c = client({ headers });
        headers[header] = 'replacement';
        await c._request('GET', '/v1/ctx');
        const sent = transport.mock.lastCall![1]!.headers as Record<
            string,
            string
        >;
        expect(sent[header]).toBe(credential);
    });

    it('reports a constant credential refusal through existing auth diagnostics without replay', async () => {
        const onAuthFailure = vi.fn();
        const c = client({
            headers: { [header]: credential },
            auth: { onAuthFailure },
        });
        await c._request('GET', '/v1/ctx');
        transport.mockResolvedValue(
            mockResponse(404, JSON.stringify({ error: 'not_found' })),
        );
        await expect(c._request('GET', '/v1/ctx')).rejects.toMatchObject({
            possiblyUnauthenticated: true,
        });
        expect(onAuthFailure).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(2);
    });
});
