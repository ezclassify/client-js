/**
 * The scheme inventory a context-bound client reads off `ctxDescribe`.
 *
 * A Context can hold more than one scheme, and its scheme resources take
 * `?scheme=` to address the ones that are not primary. The selector is a
 * Context-local key, so a client cannot construct it: the only way to learn it
 * is to be told, and this is where it is told.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';

const CROSSWALK_CONTEXT = {
    id: 'records',
    version: '1.2.3',
    description: 'Marking scheme plus the target of its migration crosswalk.',
    scheme: { id: 'levels', version: 'latest', resolvedVersion: '2.0.0' },
    schemes: [
        {
            selector: 'levels',
            id: 'levels',
            version: '2.0.0',
            roles: ['primary', 'crosswalk-source'],
        },
        {
            selector: 'partner-levels',
            id: 'partner-levels',
            version: '1.0.0',
            roles: ['crosswalk-target'],
        },
    ],
};

describe('context scheme inventory', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function ctxClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    it('reports every scheme the Context holds, primary first', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );

        await expect(ctxClient().describeSchemes()).resolves.toEqual([
            {
                selector: 'levels',
                id: 'levels',
                version: '2.0.0',
                roles: ['primary', 'crosswalk-source'],
            },
            {
                selector: 'partner-levels',
                id: 'partner-levels',
                version: '1.0.0',
                roles: ['crosswalk-target'],
            },
        ]);
    });

    it('serves the inventory from the cached description', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );
        const client = ctxClient();

        await client.describeSchemes();
        await client.describeSchemes();

        // The composition a Context version resolves to is fixed, so asking
        // twice is not a reason to go back to the server.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Callers that race the first describe share its request, so
    // `fetchProfile()` does not duplicate the seven-request assembly it chains
    // behind this one.
    it('shares one request between callers that race the first describe', async () => {
        let release: (() => void) | undefined;
        const arrival = new Promise<void>((resolve) => {
            release = resolve;
        });
        fetchMock.mockImplementation(async () => {
            await arrival;
            return mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT));
        });
        const client = ctxClient();

        const both = Promise.all([
            client.describeContext(),
            client.describeContext(),
        ]);
        release?.();
        const [first, second] = await both;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
    });

    it('lets the next caller retry after a failed describe', async () => {
        fetchMock.mockResolvedValueOnce(mockResponse(503, '{"error":"down"}'));
        const client = ctxClient();

        await expect(client.describeContext()).rejects.toThrow(EzClassifyError);

        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );
        await expect(client.describeContext()).resolves.toMatchObject({
            id: 'records',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('carries the inventory on the description itself', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );

        const description = await ctxClient().describeContext();

        expect(description.schemes.map((entry) => entry.selector)).toEqual([
            'levels',
            'partner-levels',
        ]);
    });

    it.each([
        ['scheme-only', [], undefined, { guides: false, access: false }],
        [
            'scheme plus guide',
            [{ id: 'guide', version: '1.0.0', resolvedVersion: '1.0.0' }],
            undefined,
            { guides: true, access: false },
        ],
        [
            'present empty access policy',
            [],
            { id: 'access', version: '1.0.0', resolvedVersion: '1.0.0' },
            { guides: false, access: true },
        ],
        [
            'full composition',
            [{ id: 'guide', version: '1.0.0', resolvedVersion: '1.0.0' }],
            { id: 'access', version: '1.0.0', resolvedVersion: '1.0.0' },
            { guides: true, access: true },
        ],
    ])(
        'derives synchronous component presence from the cached %s description',
        async (_name, guides, access, expected) => {
            fetchMock.mockResolvedValueOnce(
                mockResponse(
                    200,
                    JSON.stringify({
                        ...CROSSWALK_CONTEXT,
                        guides,
                        ...(access ? { access } : {}),
                    }),
                ),
            );
            const client = ctxClient();

            await client.describeContext();

            expect(client.compositionPresence).toEqual(expected);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    it('rejects a description that carries no inventory rather than deriving one', async () => {
        // The contract requires `schemes`. Deriving an entry from `scheme`
        // would invent a selector, and the Context-local key need not equal
        // the component id.
        const { schemes: _omitted, ...withoutInventory } = CROSSWALK_CONTEXT;
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(withoutInventory)),
        );

        await expect(ctxClient().describeSchemes()).rejects.toThrow(
            'Context description response carries a malformed scheme inventory',
        );
    });

    // Everything a server can put in the inventory that the client cannot
    // honor. Each one would otherwise reach a caller wearing
    // ContextSchemeDescriptor, and a selector that is not a string, or a role
    // outside the vocabulary, is not something a caller can act on.
    const malformedInventories: Array<[string, unknown]> = [
        ['the inventory is not a list at all', { levels: {} }],
        ['an entry is not an object', ['levels']],
        [
            'an entry has no selector',
            [{ id: 'levels', version: '2.0.0', roles: ['primary'] }],
        ],
        [
            'an entry has a non-string selector',
            [
                {
                    selector: 7,
                    id: 'levels',
                    version: '2.0.0',
                    roles: ['primary'],
                },
            ],
        ],
        [
            'an entry has a non-string id',
            [
                {
                    selector: 'levels',
                    id: null,
                    version: '2.0.0',
                    roles: ['primary'],
                },
            ],
        ],
        [
            'an entry has a non-string version',
            [
                {
                    selector: 'levels',
                    id: 'levels',
                    version: 2,
                    roles: ['primary'],
                },
            ],
        ],
        [
            'an entry has no roles list',
            [{ selector: 'levels', id: 'levels', version: '2.0.0' }],
        ],
        [
            'an entry has an empty roles list',
            [
                {
                    selector: 'levels',
                    id: 'levels',
                    version: '2.0.0',
                    roles: [],
                },
            ],
        ],
        [
            'an entry claims a role outside the vocabulary',
            [
                {
                    selector: 'levels',
                    id: 'levels',
                    version: '2.0.0',
                    roles: ['primary', 'crosswalk-pivot'],
                },
            ],
        ],
        [
            'a later entry is malformed behind a good one',
            [
                {
                    selector: 'levels',
                    id: 'levels',
                    version: '2.0.0',
                    roles: ['primary'],
                },
                {
                    selector: 'partner-levels',
                    id: 'partner-levels',
                    version: '1.0.0',
                    roles: ['crosswalk-target', 42],
                },
            ],
        ],
    ];

    it.each(malformedInventories)(
        'refuses the description when %s',
        async (_reason, schemes) => {
            fetchMock.mockResolvedValueOnce(
                mockResponse(
                    200,
                    JSON.stringify({ ...CROSSWALK_CONTEXT, schemes }),
                ),
            );

            const error = (await ctxClient()
                .describeSchemes()
                .catch((thrown) => thrown)) as EzClassifyError;

            expect(error).toBeInstanceOf(EzClassifyError);
            expect(error.code).toBe('MALFORMED_RESPONSE');
            expect(error.message).toMatch(/scheme inventory/);
        },
    );

    it('does not cache a description whose inventory was refused', async () => {
        // The refusal is the whole point: a rejected description must not be
        // the one a second call reads back as settled truth.
        fetchMock.mockResolvedValueOnce(
            mockResponse(
                200,
                JSON.stringify({ ...CROSSWALK_CONTEXT, schemes: ['levels'] }),
            ),
        );
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );
        const client = ctxClient();

        await expect(client.describeSchemes()).rejects.toThrow(
            /scheme inventory/,
        );

        await expect(client.describeSchemes()).resolves.toHaveLength(2);
    });

    it('refuses on a client that is not bound to a Context', async () => {
        const client = new EzClassifyClient('https://api.example.com');

        await expect(client.describeSchemes()).rejects.toThrow(
            /context-bound client/,
        );
    });

    it.each([
        ['omitted', {}],
        ['empty', { contextVersion: '' }],
    ])(
        'describes `latest` for an %s version with no Context token',
        async (_label, version) => {
            fetchMock.mockResolvedValueOnce(
                mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
            );
            const client = new EzClassifyClient('https://api.example.com', {
                contextId: 'records',
                ...version,
            });

            await expect(client.describeContext()).resolves.toMatchObject({
                id: 'records',
            });
            expect(String(fetchMock.mock.calls[0][0])).toBe(
                'https://api.example.com/v1/ctx/records/latest',
            );
        },
    );

    it('describes the latest version when the client names none', async () => {
        // `/v1/ctx/{ctxId}` answers the version list; the description lives
        // under a version segment, and "latest" is one the runtime resolves
        // to the version the token authorizes.
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );
        // A token-bound client names no version: the token authorizes one.
        const client = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextToken: 'signed-context-token',
        });

        await expect(client.describeContext()).resolves.toMatchObject({
            id: 'records',
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe(
            'https://api.example.com/v1/ctx/records/latest',
        );
    });
});

describe('context composition', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const COMPOSED = {
        ...CROSSWALK_CONTEXT,
        scheme: {
            id: 'levels',
            version: 'latest',
            resolvedVersion: '2.0.0',
            layers: [
                { id: 'corp-ext', version: 'latest', resolvedVersion: '1.2.0' },
            ],
        },
        crosswalks: [
            {
                id: 'levels-to-partner',
                version: 'latest',
                resolvedVersion: '3.4.0',
                layers: [
                    {
                        id: 'xw-ext',
                        version: '1.0.0',
                        resolvedVersion: '1.0.0',
                    },
                ],
            },
        ],
    };

    function ctxClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    it('is a body the contract declares', () => {
        const spec = yaml.load(
            readFileSync(
                resolve(
                    dirname(fileURLToPath(import.meta.url)),
                    '../vendor/spec/openapi.yaml',
                ),
                'utf-8',
            ),
        ) as Record<string, unknown>;
        const ajv = new Ajv({ strict: false });
        ajv.addSchema(spec, 'spec');
        const valid = ajv.validate(
            { $ref: 'spec#/components/schemas/CtxDescribeResponseBody' },
            COMPOSED,
        );
        expect(valid, ajv.errorsText(ajv.errors)).toBe(true);
    });

    it('reports each crosswalk with its layers, declared and resolved versions', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(COMPOSED)),
        );
        const description = await ctxClient().describeContext();
        expect(description.crosswalks).toEqual(COMPOSED.crosswalks);
        expect(description.crosswalks[0]).toMatchObject({
            version: 'latest',
            resolvedVersion: '3.4.0',
        });
    });

    it('reports the composed scheme layers the description nests under the scheme', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(COMPOSED)),
        );
        const description = await ctxClient().describeContext();
        expect(description.layers).toEqual(COMPOSED.scheme.layers);
        expect(description.scheme.layers).toEqual(COMPOSED.scheme.layers);
    });

    it('reports empty lists when the Context stacks no layers and declares no crosswalks', async () => {
        fetchMock.mockResolvedValueOnce(
            mockResponse(200, JSON.stringify(CROSSWALK_CONTEXT)),
        );
        const description = await ctxClient().describeContext();
        expect(description.layers).toEqual([]);
        expect(description.crosswalks).toEqual([]);
    });
});
