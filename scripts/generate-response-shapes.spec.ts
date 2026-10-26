// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// @ts-expect-error - plain ESM script, no type declarations
import {
    buildResponseShapes,
    writeResponseShapes,
} from './generate-response-shapes.mjs';

/**
 * The response-shape tables are what the client checks every Context response
 * against, so they have to say what the vendored contract says, no more and no
 * less, and they have to be regenerated when the contract moves.
 */

const repoRoot = path.resolve(__dirname, '..');

/** A contract with one operation whose response exercises every reduction. */
const SPEC = {
    paths: {
        '/v1/ctx/{ctxId}/{version}/thing/do': {
            post: {
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: '#/components/schemas/Envelope',
                                },
                            },
                        },
                    },
                },
            },
        },
        '/v1/ctx/{ctxId}/{version}/thing': {
            get: {
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Node' },
                            },
                        },
                    },
                },
            },
        },
        '/v1/health': {
            get: {
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['status'],
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    components: {
        schemas: {
            Envelope: {
                type: 'object',
                required: ['result'],
                properties: {
                    result: { $ref: '#/components/schemas/Result' },
                    note: { type: 'string' },
                },
            },
            Result: {
                allOf: [
                    { $ref: '#/components/schemas/Base' },
                    {
                        type: 'object',
                        required: ['items'],
                        properties: {
                            items: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Item' },
                            },
                            maybe: {
                                anyOf: [
                                    { $ref: '#/components/schemas/Item' },
                                    { type: 'null' },
                                ],
                            },
                            either: {
                                anyOf: [
                                    {
                                        type: 'object',
                                        required: ['kind', 'a'],
                                    },
                                    {
                                        type: 'object',
                                        required: ['kind', 'b'],
                                    },
                                ],
                            },
                            byId: {
                                type: 'object',
                                additionalProperties: {
                                    $ref: '#/components/schemas/Item',
                                },
                            },
                        },
                    },
                ],
            },
            Base: { type: 'object', required: ['id'] },
            Item: {
                type: 'object',
                required: ['name'],
                properties: { text: { type: 'string', description: 'x' } },
            },
            Node: {
                type: 'object',
                required: ['id'],
                properties: {
                    children: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Node' },
                    },
                },
            },
        },
    },
};

describe('buildResponseShapes', () => {
    const { operations, shapes } = buildResponseShapes(SPEC);

    it('keys each Context operation by method and route', () => {
        expect(Object.keys(operations)).toEqual(['GET thing', 'POST thing/do']);
    });

    it('leaves out routes that are not Context operations', () => {
        expect(JSON.stringify(shapes)).not.toContain('status');
    });

    it('keeps what a response must carry, merged through allOf', () => {
        expect(shapes.Result).toMatchObject({
            kind: 'object',
            required: ['id', 'items'],
        });
    });

    it('keeps the shape of an array element and of a map value', () => {
        expect(shapes.Result.properties.items).toEqual({
            kind: 'array',
            items: 'Item',
        });
        expect(shapes.Result.properties.byId).toEqual({
            kind: 'object',
            values: 'Item',
        });
    });

    it('carries nullability beside a reference', () => {
        expect(shapes.Result.properties.maybe).toEqual({
            ref: 'Item',
            nullable: true,
        });
    });

    it('keeps only what every branch of a union requires', () => {
        expect(shapes.Result.properties.either).toEqual({
            kind: 'object',
            required: ['kind'],
        });
    });

    it('drops members that ask nothing of the client', () => {
        expect(shapes.Envelope.properties).not.toHaveProperty('note');
        expect(shapes.Item).toEqual({ kind: 'object', required: ['name'] });
    });

    it('terminates on a schema that contains itself', () => {
        expect(shapes.Node.properties.children).toEqual({
            kind: 'array',
            items: 'Node',
        });
        expect(operations['GET thing']).toBe('Node');
    });
});

describe('writeResponseShapes', () => {
    /** A repository holding the real vendored contract and no generated file. */
    function repository(): string {
        const root = mkdtempSync(path.join(tmpdir(), 'response-shapes-'));
        mkdirSync(path.join(root, 'vendor', 'spec'), { recursive: true });
        mkdirSync(path.join(root, 'src'));
        copyFileSync(
            path.join(repoRoot, 'vendor/spec/openapi.yaml'),
            path.join(root, 'vendor/spec/openapi.yaml'),
        );
        return root;
    }

    it('writes the same bytes the repository has checked in', () => {
        const root = repository();
        writeResponseShapes({ root });
        expect(
            readFileSync(path.join(root, 'src/response-shapes.ts'), 'utf8'),
        ).toBe(
            readFileSync(path.join(repoRoot, 'src/response-shapes.ts'), 'utf8'),
        );
    });

    it('leaves a current file untouched, file time included', () => {
        const root = repository();
        writeResponseShapes({ root });
        const target = path.join(root, 'src/response-shapes.ts');
        const old = new Date('2020-01-01T00:00:00Z');
        utimesSync(target, old, old);

        const again = writeResponseShapes({ root });

        expect(again.written).toBe(false);
        expect(statSync(target).mtime.getTime()).toBe(old.getTime());
    });

    it('rewrites the file when the contract asks something new', () => {
        const root = repository();
        const spec = path.join(root, 'vendor/spec/openapi.yaml');
        // JSON is YAML, so the small contract above stands in for a vendored one.
        writeFileSync(spec, JSON.stringify(SPEC));
        writeResponseShapes({ root });
        const before = readFileSync(
            path.join(root, 'src/response-shapes.ts'),
            'utf8',
        );

        const changed = structuredClone(SPEC);
        changed.components.schemas.Item.required.push('more');
        writeFileSync(spec, JSON.stringify(changed));
        const again = writeResponseShapes({ root });

        expect(again.written).toBe(true);
        const after = readFileSync(
            path.join(root, 'src/response-shapes.ts'),
            'utf8',
        );
        expect(after).not.toBe(before);
        expect(after).toContain('"more"');
    });

    it('does not rewrite the file for a change that asks nothing new', () => {
        const root = repository();
        writeResponseShapes({ root });
        const spec = path.join(root, 'vendor/spec/openapi.yaml');
        writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n# a comment\n`);
        expect(writeResponseShapes({ root }).written).toBe(false);
    });
});
