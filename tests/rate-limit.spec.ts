/**
 * Rate-limit refusals.
 *
 * Every operation can answer 429, so the delay the server asks for reaches the
 * caller on the error type rather than only inside a parsed body. The exchange
 * is built from the vendored contract (the corpus has no 429 recording): the
 * body is the contract's own example, checked against its `RateLimitError`
 * schema, and the header is the one the response declares.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';

interface RateLimitSpec {
    components: {
        responses: {
            TooManyRequests: {
                headers: Record<string, unknown>;
                content: {
                    'application/json': { example: Record<string, unknown> };
                };
            };
        };
        schemas: {
            RateLimitError: { required: string[] };
        };
    };
}

const spec = yaml.load(
    readFileSync(
        resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../vendor/spec/openapi.yaml',
        ),
        'utf-8',
    ),
) as RateLimitSpec;

const declared = spec.components.responses.TooManyRequests;
const specBody = declared.content['application/json'].example;
const specRetryAfter = specBody.retryAfter as number;

const BASE_URL = 'https://api.example.com';

async function refusal(response: Response): Promise<EzClassifyError> {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(response);
    const client = new EzClassifyClient(BASE_URL, {
        contextId: 'test-context',
        contextVersion: '1.0.0',
        disableCache: true,
    });
    try {
        await client._request('GET', '/v1/ctx');
    } catch (error) {
        if (error instanceof EzClassifyError) return error;
        throw error;
    }
    throw new Error('expected a rejection');
}

describe('429 Too Many Requests', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('builds from an exchange the contract declares', () => {
        expect(Object.keys(declared.headers)).toContain('Retry-After');
        expect(spec.components.schemas.RateLimitError.required).toEqual([
            'error',
            'retryAfter',
        ]);
        expect(specBody).toEqual({
            error: 'Too Many Requests',
            retryAfter: expect.any(Number),
        });
    });

    it('surfaces Retry-After as retryAfter seconds', async () => {
        const err = await refusal(
            mockResponse(429, JSON.stringify(specBody), {
                'Retry-After': String(specRetryAfter),
            }),
        );
        expect(err.status).toBe(429);
        expect(err.retryAfter).toBe(specRetryAfter);
    });

    it('prefers the header over the body when they differ', async () => {
        const err = await refusal(
            mockResponse(429, JSON.stringify(specBody), {
                'Retry-After': '7',
            }),
        );
        expect(err.retryAfter).toBe(7);
    });

    it('reads the body when the header is absent', async () => {
        const err = await refusal(mockResponse(429, JSON.stringify(specBody)));
        expect(err.retryAfter).toBe(specRetryAfter);
    });

    it('reads the body when the header is not a number of seconds', async () => {
        const err = await refusal(
            mockResponse(429, JSON.stringify(specBody), {
                'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
            }),
        );
        expect(err.retryAfter).toBe(specRetryAfter);
    });

    it('leaves retryAfter unset when the server named no delay', async () => {
        const err = await refusal(
            mockResponse(429, JSON.stringify({ error: 'Too Many Requests' })),
        );
        expect(err.status).toBe(429);
        expect(err.retryAfter).toBeUndefined();
    });

    it('keeps the parsed body beside the surfaced delay', async () => {
        const err = await refusal(
            mockResponse(429, JSON.stringify(specBody), {
                'Retry-After': String(specRetryAfter),
            }),
        );
        expect(err.body).toEqual(specBody);
        expect(err.message).toContain('Too Many Requests');
    });

    it('is not offered on a refusal that is not a rate limit', async () => {
        const err = await refusal(
            mockResponse(503, JSON.stringify({ error: 'busy' }), {
                'Retry-After': '30',
            }),
        );
        expect(err.retryAfter).toBeUndefined();
    });
});
