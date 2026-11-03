import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientFromConnection, readClientConnection } from '../src/connection';
import { mockResponse, stubFetch } from './fetch-mock';
const grant = 'example-private-grant';
const config = () => ({
    baseUrl: 'https://runtime.example',
    contextId: 'mission',
    contextVersion: '1.0.0',
    headers: { 'x-ezclassify-application-grant': grant },
    userHeader: 'x-authenticated-subject',
});
const fetch = globalThis.fetch;
describe('portable client connection', () => {
    let transport: ReturnType<typeof stubFetch>;
    beforeEach(() => {
        transport = stubFetch();
        transport.mockResolvedValue(
            mockResponse(200, JSON.stringify({ ok: true })),
        );
    });
    afterEach(() => {
        globalThis.fetch = fetch;
    });
    it('loads JSON without mutation and isolates interleaved end users', async () => {
        const input = config();
        const original = structuredClone(input);
        const first = clientFromConnection(
            input,
            { user: 'person-a' },
            { heartbeat: false, disableCache: true },
        );
        const second = clientFromConnection(
            input,
            { user: 'person-b' },
            { heartbeat: false, disableCache: true },
        );
        await Promise.all([
            first._request('GET', '/v1/ctx'),
            second._request('GET', '/v1/ctx'),
        ]);
        expect(
            transport.mock.calls.map(
                (call) =>
                    (call[1]!.headers as Record<string, string>)[
                        'x-authenticated-subject'
                    ],
            ),
        ).toEqual(['person-a', 'person-b']);
        expect(input).toEqual(original);
    });
    it('requires the host token supplier for a verified client', async () => {
        const { userHeader: _, ...input } = config();
        const verified = {
            ...input,
            auth: { issuer: 'https://idp.example', audience: 'runtime' },
        };
        expect(() =>
            clientFromConnection(verified, {}, { heartbeat: false }),
        ).toThrow();
        const client = clientFromConnection(
            verified,
            { auth: { token: () => 'user-token' } },
            { heartbeat: false },
        );
        await client._request('GET', '/v1/ctx');
        expect(
            (transport.mock.lastCall![1]!.headers as Record<string, string>)
                .Authorization,
        ).toBe('Bearer user-token');
    });
    it.each([
        'authorization',
        'cookie',
        'host',
        'origin',
        'x-ezclassify-application-grant',
        'x-ezclassify-context-token',
        'x-ezclassify-identity-token',
    ])('refuses identity injection through %s', (userHeader) => {
        expect(() =>
            readClientConnection({ ...config(), userHeader }),
        ).toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
    it('refuses duplicate headers and credential-bearing URLs without leaking the grant', () => {
        const input = config();
        expect(() =>
            readClientConnection({
                ...input,
                headers: {
                    ...input.headers,
                    'X-EZCLASSIFY-APPLICATION-GRANT': grant,
                },
            }),
        ).toThrow();
        for (const baseUrl of [
            'https://user:password@runtime.example',
            'http://runtime.example',
            'https://runtime.example?grant=' + grant,
        ])
            expect(() => readClientConnection({ ...input, baseUrl })).toThrow();
        try {
            readClientConnection({ ...input, unknown: grant });
        } catch (error) {
            expect(String(error)).not.toContain(grant);
        }
    });
    it('never silently drops unexpected or missing caller identity', () => {
        expect(() =>
            clientFromConnection(config(), {}, { heartbeat: false }),
        ).toThrow();
        const { userHeader: _, ...unattended } = config();
        expect(() =>
            clientFromConnection(
                unattended,
                { user: 'unexpected' },
                { heartbeat: false },
            ),
        ).toThrow();
        expect(() =>
            clientFromConnection(
                config(),
                { user: 'person\nforged' },
                { heartbeat: false },
            ),
        ).toThrow();
    });
    it('forwards only explicitly configured user attribute headers and keeps callers isolated', async () => {
        const input = {
            ...config(),
            userHeaders: {
                clearance: 'x-customer-clearance',
                tenant: 'x-customer-tenant',
            },
        };
        const first = clientFromConnection(
            input,
            {
                user: 'person-a',
                attributes: { clearance: 'SECRET', tenant: 'one' },
            },
            { heartbeat: false, disableCache: true },
        );
        const second = clientFromConnection(
            input,
            { user: 'person-b', attributes: { tenant: 'two' } },
            { heartbeat: false, disableCache: true },
        );
        await Promise.all([
            first._request('GET', '/v1/ctx'),
            second._request('GET', '/v1/ctx'),
        ]);
        const headers = transport.mock.calls.map(
            (call) => call[1]!.headers as Record<string, string>,
        );
        expect(headers[0]).toMatchObject({
            'x-customer-clearance': 'SECRET',
            'x-customer-tenant': 'one',
        });
        expect(headers[1]).toMatchObject({ 'x-customer-tenant': 'two' });
        expect(headers[1]).not.toHaveProperty('x-customer-clearance');
        expect(() =>
            clientFromConnection(
                input,
                { user: 'person', attributes: { notConfigured: 'value' } },
                { heartbeat: false },
            ),
        ).toThrow();
        expect(() =>
            readClientConnection({
                ...input,
                userHeaders: { clearance: 'Authorization' },
            }),
        ).toThrow();
        expect(() =>
            readClientConnection({
                ...input,
                userHeaders: { clearance: 'x-authenticated-subject' },
            }),
        ).toThrow();
        expect(() =>
            readClientConnection({
                ...input,
                userHeaders: {
                    one: 'x-customer-value',
                    two: 'X-Customer-Value',
                },
            }),
        ).toThrow();
    });
    it('permits an absent user only when the connection explicitly declares optional identity', async () => {
        const client = clientFromConnection(
            { ...config(), userRequired: false },
            {},
            { heartbeat: false },
        );
        await client._request('GET', '/v1/ctx');
        expect(transport.mock.lastCall![1]!.headers).not.toHaveProperty(
            'x-authenticated-subject',
        );
        expect(() =>
            clientFromConnection(
                { ...config(), userRequired: false },
                { user: 'forged\nheader' },
                { heartbeat: false },
            ),
        ).toThrow();
    });
    it('supports explicitly optional verified users and refuses malformed token suppliers', async () => {
        const { userHeader: _, ...base } = config();
        const input = {
            ...base,
            auth: {
                issuer: 'https://idp.example',
                audience: 'runtime',
                required: false,
            },
        };
        const client = clientFromConnection(input, {}, { heartbeat: false });
        await client._request('GET', '/v1/ctx');
        expect(transport.mock.lastCall![1]!.headers).not.toHaveProperty(
            'Authorization',
        );
        expect(() =>
            clientFromConnection(
                input,
                { auth: { token: undefined as never } },
                { heartbeat: false },
            ),
        ).toThrow();
    });
});
