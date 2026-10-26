/**
 * Presence checks for Context operation responses.
 *
 * A 200 whose body lacks a member the contract requires is a failure, whether
 * the member is on the envelope or three levels down inside the result. The
 * client has to find that before the response is filed in the cache: under a
 * version pin a filed entry never expires, so a body that decoded to a zero
 * value would answer wrongly for the life of the client.
 *
 * The requirements come from the vendored OpenAPI contract through
 * `scripts/generate-response-shapes.mjs`, not from a list kept here. This file
 * only reads them.
 */

import { ErrorCodes, EzClassifyError } from './errors';
import { OPERATION_RESPONSE_SHAPES, RESPONSE_SHAPES } from './response-shapes';

/**
 * What a response value has to satisfy, reduced to presence.
 *
 * Only what a client can check without a schema engine is kept: which members
 * are required, which members and collections carry requirements of their own,
 * and whether null is a legal value.
 *
 * @internal
 */
export interface ResponseShape {
    /** The value must be an object or an array before its parts are read. */
    readonly kind?: 'object' | 'array';
    /** Members the value must carry. */
    readonly required?: readonly string[];
    /** Shapes of the members that carry requirements of their own. */
    readonly properties?: Readonly<Record<string, ResponseShape | string>>;
    /** Shape every array element must have. */
    readonly items?: ResponseShape | string;
    /** Shape every value of a map must have. */
    readonly values?: ResponseShape | string;
    /** Null is a legal value. */
    readonly nullable?: boolean;
    /**
     * Name of a shape in the generated `RESPONSE_SHAPES` table this one adds
     * to.
     */
    readonly ref?: string;
}

/** The shape a name or inline definition stands for. */
function resolveShape(
    shape: ResponseShape | string | undefined,
): ResponseShape | undefined {
    if (shape === undefined) return undefined;
    if (typeof shape === 'string') return RESPONSE_SHAPES[shape];
    if (shape.ref === undefined) return shape;
    return { ...RESPONSE_SHAPES[shape.ref], nullable: shape.nullable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Find the first place a value falls short of a shape.
 *
 * A null in an optional member counts as absent, which is how the wire spells
 * it. A null in a required member is a missing member unless the contract
 * allows null there.
 *
 * @param value - The decoded JSON value
 * @param shape - What it has to satisfy
 * @param pointer - JSON pointer to `value`, for the report
 * @returns The JSON pointer of the first missing or mis-shaped part, or
 *   undefined when the value satisfies the shape
 * @internal
 */
export function findShapeViolation(
    value: unknown,
    shape: ResponseShape | string | undefined,
    pointer = '',
): string | undefined {
    const resolved = resolveShape(shape);
    if (resolved === undefined) return undefined;

    if (resolved.kind === 'array') {
        if (!Array.isArray(value)) return pointer;
        const items = resolved.items;
        if (items === undefined) return undefined;
        for (let index = 0; index < value.length; index += 1) {
            const element: unknown = value[index];
            const path = `${pointer}/${index}`;
            if (element === null && !resolveShape(items)?.nullable) {
                return path;
            }
            const violation =
                element === null
                    ? undefined
                    : findShapeViolation(element, items, path);
            if (violation !== undefined) return violation;
        }
        return undefined;
    }

    if (resolved.kind === 'object') {
        if (!isRecord(value)) return pointer;
        for (const name of resolved.required ?? []) {
            const member = value[name];
            if (!Object.hasOwn(value, name) || member === undefined) {
                return `${pointer}/${name}`;
            }
            if (
                member === null &&
                !resolveShape(resolved.properties?.[name])?.nullable
            ) {
                return `${pointer}/${name}`;
            }
        }
        for (const [name, child] of Object.entries(resolved.properties ?? {})) {
            const member = value[name];
            if (!Object.hasOwn(value, name) || member == null) continue;
            const violation = findShapeViolation(
                member,
                child,
                `${pointer}/${name}`,
            );
            if (violation !== undefined) return violation;
        }
        if (resolved.values !== undefined) {
            for (const [name, member] of Object.entries(value)) {
                if (member == null) continue;
                const violation = findShapeViolation(
                    member,
                    resolved.values,
                    `${pointer}/${name}`,
                );
                if (violation !== undefined) return violation;
            }
        }
    }
    return undefined;
}

/**
 * The route a Context operation path addresses, in the form the shape table is
 * keyed by.
 *
 * A path is `/v1/ctx/{id}/{version}/{route}`, or `/v1/ctx/{id}/{route}` when a
 * signed carrier supplies the version. Whether the version segment is there is
 * settled by the table: the first reading that names a known route wins.
 */
function operationKey(method: string, path: string): string | undefined {
    const [pathname] = path.split('?');
    const segments = (pathname ?? '').split('/');
    // ['', 'v1', 'ctx', id, ...rest]
    if (segments[1] !== 'v1' || segments[2] !== 'ctx') return undefined;
    for (const skip of [4, 5]) {
        const route = segments.slice(skip).join('/');
        const key = `${method} ${route}`;
        if (route !== '' && Object.hasOwn(OPERATION_RESPONSE_SHAPES, key)) {
            return key;
        }
    }
    return undefined;
}

/**
 * Refuse a Context operation response that lacks a member the contract
 * requires.
 *
 * A path that is not a Context operation, or that the contract declares no
 * shape for, passes untouched.
 *
 * @param method - The request method
 * @param path - The request path, with its query
 * @param body - The decoded response body
 * @throws {EzClassifyError} When a required member is missing at any depth
 * @internal
 */
export function assertResponseShape(
    method: string,
    path: string,
    body: unknown,
): void {
    const key = operationKey(method, path);
    if (key === undefined) return;
    const violation = findShapeViolation(body, OPERATION_RESPONSE_SHAPES[key]);
    if (violation === undefined) return;
    throw new EzClassifyError(
        `Malformed response from ${key}: ${violation === '' ? 'the body' : violation} is missing or not what the contract declares`,
        ErrorCodes.MALFORMED_RESPONSE,
    );
}
