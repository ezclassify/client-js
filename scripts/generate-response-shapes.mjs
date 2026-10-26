#!/usr/bin/env node
/**
 * Writes src/response-shapes.ts: what the vendored OpenAPI contract requires of
 * every Context operation response, reduced to the parts a client can check
 * without a schema engine.
 *
 * A 200 whose body is missing a member the contract requires, at any depth, is
 * a failure. The client checks that inside the call, before the response cache
 * files it, so the checks have to come from the contract itself rather than
 * from a hand-kept list that drifts. For each operation the file holds the
 * response schema reduced to: the members it requires, the members and
 * collections that carry requirements of their own, and whether a value may be
 * null. Everything else in a schema (descriptions, formats, enums, scalar
 * types) is not a presence question and is dropped. A union is kept only as far
 * as its branches agree: the members every object branch requires.
 *
 * Run via: node scripts/generate-response-shapes.mjs
 *
 * Called with generate-spec-version.mjs at the head of the `build`, `test` and
 * `typecheck` scripts. The file is written only when its bytes change, for the
 * reason given in generate-spec-version.mjs.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');

/** Prefix every Context operation path starts with in the contract. */
const CONTEXT_BASE = '/v1/ctx/{ctxId}/{version}/';

/**
 * Reduce a schema to the presence requirements a response must satisfy.
 *
 * Builds one table entry per named schema so a recursive schema terminates and
 * a schema shared by many operations is stored once.
 */
class ShapeCompiler {
    /** @param {Record<string, any>} schemas - `components.schemas` */
    constructor(schemas) {
        this.schemas = schemas;
        /** @type {Map<string, object | null>} */
        this.defs = new Map();
        /** Names being compiled, to stop a recursive schema at its own ref. */
        this.compiling = new Set();
    }

    /**
     * Compile a schema or `$ref` into a shape.
     *
     * @param {any} schema - A schema object, possibly a `$ref`.
     * @returns {object | string | null} A shape, the name of a compiled shape,
     *   or null when the schema asks nothing a client can check.
     */
    compile(schema) {
        if (schema === null || typeof schema !== 'object') return null;
        if (typeof schema.$ref === 'string') return this.reference(schema.$ref);
        return this.inline(schema);
    }

    /** @param {string} ref - A `#/components/schemas/Name` pointer. */
    reference(ref) {
        const name = ref.split('/').pop();
        if (!this.schemas[name]) throw new Error(`unresolved $ref ${ref}`);
        if (!this.defs.has(name) && !this.compiling.has(name)) {
            this.compiling.add(name);
            const shape = this.inline(this.schemas[name]);
            this.compiling.delete(name);
            this.defs.set(name, shape);
        }
        // A name still being compiled is a recursive reference; it resolves to
        // the finished shape by the time anything is validated.
        return this.defs.get(name) === null ? null : name;
    }

    /** @param {any} schema - A schema object with no `$ref` of its own. */
    inline(schema) {
        const nullable = isNullable(schema);
        const parts = [];
        if (Array.isArray(schema.allOf)) {
            for (const branch of schema.allOf) {
                parts.push(this.resolvedParts(branch));
            }
        }
        const union = schema.anyOf ?? schema.oneOf;
        if (Array.isArray(union)) {
            const branches = union.filter((branch) => !isNullType(branch));
            if (branches.length < union.length) {
                // `X | null`: the non-null branches describe the value.
                return this.nullableOf(branches, nullable);
            }
            const common = this.commonRequired(branches);
            if (common.length > 0) {
                parts.push({ kind: 'object', required: common });
            }
        }
        parts.push(this.ownParts(schema));
        return this.merge(parts, nullable || hasNullBranch(union));
    }

    /**
     * The shape of `X | null`.
     *
     * @param {any[]} branches - The non-null branches.
     * @param {boolean} alreadyNullable - Whether the schema also says null.
     */
    nullableOf(branches, alreadyNullable) {
        if (branches.length !== 1) {
            // A union of several non-null types: nothing shared to check, but
            // the value may be null.
            return alreadyNullable || branches.length > 0
                ? { nullable: true }
                : null;
        }
        const inner = this.compile(branches[0]);
        if (inner === null) return { nullable: true };
        // A reference stays a reference; nullability is carried beside it.
        if (typeof inner === 'string') return { ref: inner, nullable: true };
        return { ...inner, nullable: true };
    }

    /** Required members every object branch of a union shares. */
    commonRequired(branches) {
        let common = null;
        for (const branch of branches) {
            const resolved = this.resolvedParts(branch);
            if (resolved.kind !== 'object') return [];
            common =
                common === null
                    ? [...resolved.required]
                    : common.filter((name) => resolved.required.includes(name));
        }
        return common ?? [];
    }

    /** A schema's own requirements, with `$ref` and `allOf` followed. */
    resolvedParts(schema) {
        if (typeof schema?.$ref === 'string') {
            const name = schema.$ref.split('/').pop();
            return this.partsOf(this.schemas[name]);
        }
        return this.partsOf(schema);
    }

    /** The own requirements of a schema, flattened through `allOf`. */
    partsOf(schema) {
        const parts = [];
        for (const branch of schema?.allOf ?? []) {
            parts.push(this.resolvedParts(branch));
        }
        parts.push(this.ownParts(schema));
        return this.merge(parts, false, true);
    }

    /** The requirements a schema states directly. */
    ownParts(schema) {
        const out = { kind: undefined, required: [], properties: {} };
        if (hasType(schema, 'object') || schema.properties) {
            out.kind = 'object';
            out.required = Array.isArray(schema.required)
                ? [...schema.required]
                : [];
            for (const [name, child] of Object.entries(
                schema.properties ?? {},
            )) {
                const compiled = this.compile(child);
                if (compiled !== null) out.properties[name] = compiled;
            }
            if (
                schema.additionalProperties &&
                typeof schema.additionalProperties === 'object'
            ) {
                const values = this.compile(schema.additionalProperties);
                if (values !== null) out.values = values;
            }
        } else if (hasType(schema, 'array')) {
            out.kind = 'array';
            if (schema.items) {
                const items = this.compile(schema.items);
                if (items !== null) out.items = items;
            }
        }
        return out;
    }

    /**
     * Fold parts into one shape, or null when nothing is left to check.
     *
     * @param {any[]} parts - Shapes in the internal `kind`/`required` form.
     * @param {boolean} nullable - Whether null is a legal value.
     * @param {boolean} [raw] - Return the internal form instead of a shape.
     */
    merge(parts, nullable, raw = false) {
        const merged = { kind: undefined, required: [], properties: {} };
        for (const part of parts) {
            merged.kind ??= part.kind;
            for (const name of part.required ?? []) {
                if (!merged.required.includes(name)) merged.required.push(name);
            }
            for (const [name, child] of Object.entries(part.properties ?? {})) {
                merged.properties[name] = child;
            }
            if (part.items) merged.items = part.items;
            if (part.values) merged.values = part.values;
        }
        if (raw) return merged;
        return toShape(merged, nullable);
    }
}

/**
 * Convert the internal form to the emitted shape, dropping empty parts.
 *
 * @param {any} merged - The merged internal form.
 * @param {boolean} nullable - Whether null is a legal value.
 * @returns {object | null} The shape, or null when it checks nothing.
 */
function toShape(merged, nullable) {
    const shape = {};
    const required = merged.required.slice().sort();
    const properties = sortedEntries(merged.properties);
    const hasContent =
        required.length > 0 ||
        properties.length > 0 ||
        merged.items !== undefined ||
        merged.values !== undefined;
    if (hasContent && merged.kind) shape.kind = merged.kind;
    if (required.length > 0) shape.required = required;
    if (properties.length > 0) {
        shape.properties = Object.fromEntries(properties);
    }
    if (merged.items !== undefined) shape.items = merged.items;
    if (merged.values !== undefined) shape.values = merged.values;
    if (nullable) shape.nullable = true;
    return Object.keys(shape).length === 0 ? null : shape;
}

/** @param {Record<string, unknown>} object */
function sortedEntries(object) {
    return Object.entries(object).sort(([a], [b]) => a.localeCompare(b));
}

/** Whether a schema declares `type` (alone or in a type list). */
function hasType(schema, type) {
    return Array.isArray(schema.type)
        ? schema.type.includes(type)
        : schema.type === type;
}

/** Whether a schema is the JSON null type. */
function isNullType(schema) {
    return schema?.type === 'null';
}

/** Whether a union lists the null type among its branches. */
function hasNullBranch(union) {
    return Array.isArray(union) && union.some(isNullType);
}

/** Whether a schema's own `type` list admits null. */
function isNullable(schema) {
    return Array.isArray(schema.type) && schema.type.includes('null');
}

/**
 * Build the shape tables for a contract.
 *
 * @param {any} spec - The parsed OpenAPI document.
 * @returns {{
 *     operations: Record<string, object | string>;
 *     shapes: Record<string, object>;
 * }}
 *   The shape of each Context operation response keyed `METHOD route`, and the
 *   named shapes they refer to.
 */
export function buildResponseShapes(spec) {
    const compiler = new ShapeCompiler(spec.components?.schemas ?? {});
    /** @type {Record<string, object | string>} */
    const operations = {};
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        if (!path.startsWith(CONTEXT_BASE)) continue;
        const route = path.slice(CONTEXT_BASE.length);
        for (const method of ['get', 'post']) {
            const schema =
                item[method]?.responses?.['200']?.content?.['application/json']
                    ?.schema;
            if (!schema) continue;
            const shape = compiler.compile(schema);
            if (shape !== null) {
                operations[`${method.toUpperCase()} ${route}`] = shape;
            }
        }
    }

    // Keep only the named shapes an operation can reach.
    const reachable = new Set();
    const visit = (shape) => {
        if (typeof shape === 'string') {
            if (reachable.has(shape)) return;
            reachable.add(shape);
            visit(compiler.defs.get(shape));
            return;
        }
        if (shape === null || typeof shape !== 'object') return;
        if (shape.ref) visit(shape.ref);
        for (const child of Object.values(shape.properties ?? {})) {
            visit(child);
        }
        if (shape.items) visit(shape.items);
        if (shape.values) visit(shape.values);
    };
    Object.values(operations).forEach(visit);

    const shapes = {};
    for (const name of [...reachable].sort()) {
        const shape = compiler.defs.get(name);
        if (shape) shapes[name] = shape;
    }
    return { operations: sortObject(operations), shapes };
}

/** @param {Record<string, unknown>} object */
function sortObject(object) {
    return Object.fromEntries(sortedEntries(object));
}

/**
 * Bring a repository's response-shape tables up to date with its vendored spec.
 *
 * @param options - `root` is the repository root to write into.
 * @returns How many operations and named shapes were written, and whether the
 *   file had to be rewritten.
 */
export function writeResponseShapes({ root = clientDir } = {}) {
    const spec = yaml.load(
        readFileSync(resolve(root, 'vendor/spec/openapi.yaml'), 'utf-8'),
    );
    const { operations, shapes } = buildResponseShapes(spec);

    const lines = [
        '// @generated: Do not edit. Regenerated by scripts/generate-response-shapes.mjs.',
        '// Source: vendor/spec/openapi.yaml. See response-check.ts for how the tables are read.',
        "import type { ResponseShape } from './response-check';",
        '',
        '/** Named shapes the operation shapes refer to. */',
        'export const RESPONSE_SHAPES: Readonly<Record<string, ResponseShape>> = {',
        ...Object.entries(shapes).map(
            ([name, shape]) =>
                `    ${JSON.stringify(name)}: ${compact(shape)},`,
        ),
        '};',
        '',
        '/** The shape each Context operation response must have, by `METHOD route`. */',
        'export const OPERATION_RESPONSE_SHAPES: Readonly<',
        '    Record<string, ResponseShape | string>',
        '> = {',
        ...Object.entries(operations).map(
            ([key, shape]) => `    ${JSON.stringify(key)}: ${compact(shape)},`,
        ),
        '};',
        '',
    ];
    const output = lines.join('\n');

    const target = resolve(root, 'src/response-shapes.ts');
    const counts = {
        operations: Object.keys(operations).length,
        shapes: Object.keys(shapes).length,
    };
    if (existsSync(target) && readFileSync(target, 'utf-8') === output) {
        return { ...counts, written: false };
    }
    writeFileSync(target, output, 'utf-8');
    return { ...counts, written: true };
}

/**
 * One-line JSON for a shape, with keys unquoted where they are identifiers.
 *
 * @param {unknown} value - A shape or the name of one.
 * @returns {string} TypeScript source for the value.
 */
function compact(value) {
    return JSON.stringify(value).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { operations, shapes, written } = writeResponseShapes();
    console.log(
        written
            ? `Generated response-shapes.ts (${operations} operations, ${shapes} shapes)`
            : `response-shapes.ts is current (${operations} operations, ${shapes} shapes)`,
    );
}
