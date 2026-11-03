import {
    EzClassifyClient,
    type ClientAuth,
    type EzClassifyClientOptions,
} from './ezclassify-client';
import { ErrorCodes, EzClassifyError } from './errors';

/** Portable client configuration produced by Studio. Grants are credentials. */
export interface ClientConnection {
    baseUrl: string;
    contextId: string;
    contextVersion: string;
    headers: Record<string, string>;
    userHeader?: string;
    /** Subject-header identity defaults to required unless explicitly optional. */
    userRequired?: boolean;
    /** Configured user-attribute name to HTTP header; values are caller scoped. */
    userHeaders?: Record<string, string>;
    /** Expected customer IdP; the host supplies its own authenticated session. */
    auth?: { issuer: string; audience: string; required?: boolean };
}

/** Request-scoped user material never belongs in a saved connection object. */
export interface ConnectionCaller {
    user?: string;
    attributes?: Record<string, string>;
    auth?: ClientAuth;
}

function invalid(): never {
    // Never include rejected values: a connection object contains a grant.
    throw new EzClassifyError(
        'Invalid client connection or caller identity.',
        ErrorCodes.INVALID_INPUT,
    );
}
function object(value: unknown): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value))
    );
}
function text(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 65536 &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value)
    );
}

/** Validate untrusted JSON before applying a caller's user identity to it. */
export function readClientConnection(input: unknown): ClientConnection {
    if (
        !object(input) ||
        Object.keys(input).some(
            (key) =>
                ![
                    'baseUrl',
                    'contextId',
                    'contextVersion',
                    'headers',
                    'userHeader',
                    'userRequired',
                    'userHeaders',
                    'auth',
                ].includes(key),
        ) ||
        !text(input.baseUrl) ||
        !text(input.contextId) ||
        !text(input.contextVersion) ||
        !object(input.headers) ||
        Object.keys(input.headers).length > 32
    )
        invalid();
    let url: URL;
    try {
        url = new URL(input.baseUrl);
    } catch {
        invalid();
    }
    if (
        (url.protocol !== 'https:' &&
            !(
                url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        invalid();
    const names = new Set<string>();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) {
        const lower = name.toLowerCase();
        if (
            !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/u.test(name) ||
            !text(value) ||
            names.has(lower) ||
            [
                'authorization',
                'cookie',
                'host',
                'origin',
                'x-ezclassify-context-token',
                'x-ezclassify-identity-token',
                '__proto__',
            ].includes(lower)
        )
            invalid();
        names.add(lower);
        headers[lower] = value;
    }
    if (!names.has('x-ezclassify-application-grant')) invalid();
    if (
        input.userHeader !== undefined &&
        (!text(input.userHeader) ||
            !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/u.test(input.userHeader) ||
            names.has(input.userHeader.toLowerCase()) ||
            [
                'authorization',
                'cookie',
                'host',
                'origin',
                'x-ezclassify-context-token',
                'x-ezclassify-identity-token',
                '__proto__',
            ].includes(input.userHeader.toLowerCase()))
    )
        invalid();
    if (
        input.userRequired !== undefined &&
        (typeof input.userRequired !== 'boolean' ||
            input.userHeader === undefined)
    )
        invalid();
    if (input.userHeader !== undefined)
        names.add((input.userHeader as string).toLowerCase());
    const userHeaders: Record<string, string> = {};
    if (input.userHeaders !== undefined) {
        if (
            !object(input.userHeaders) ||
            Object.keys(input.userHeaders).length > 16
        )
            invalid();
        for (const [attribute, header] of Object.entries(input.userHeaders)) {
            if (
                !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(attribute) ||
                !text(header) ||
                !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/u.test(header)
            )
                invalid();
            const name = header.toLowerCase();
            if (
                names.has(name) ||
                [
                    'authorization',
                    'cookie',
                    'host',
                    'origin',
                    'x-ezclassify-context-token',
                    'x-ezclassify-identity-token',
                    '__proto__',
                ].includes(name)
            )
                invalid();
            names.add(name);
            userHeaders[attribute] = name;
        }
    }
    if (
        input.auth !== undefined &&
        (!object(input.auth) ||
            Object.keys(input.auth).some(
                (key) => !['issuer', 'audience', 'required'].includes(key),
            ) ||
            !text(input.auth.issuer) ||
            !text(input.auth.audience) ||
            input.userHeader !== undefined ||
            input.userHeaders !== undefined ||
            (input.auth.required !== undefined &&
                typeof input.auth.required !== 'boolean'))
    )
        invalid();
    return {
        baseUrl: input.baseUrl,
        contextId: input.contextId,
        contextVersion: input.contextVersion,
        headers,
        ...(input.userRequired !== undefined
            ? { userRequired: input.userRequired as boolean }
            : {}),
        ...(input.userHeaders !== undefined ? { userHeaders } : {}),
        ...(input.userHeader !== undefined
            ? { userHeader: input.userHeader as string }
            : {}),
        ...(input.auth !== undefined
            ? {
                  auth: {
                      issuer: (input.auth as Record<string, string>).issuer!,
                      audience: (input.auth as Record<string, string>)
                          .audience!,
                      ...((input.auth as Record<string, unknown>).required !==
                      undefined
                          ? {
                                required: (
                                    input.auth as Record<string, boolean>
                                ).required!,
                            }
                          : {}),
                  },
              }
            : {}),
    };
}

/**
 * Load Studio's connection JSON unchanged, adding this caller's session only. A
 * fresh client owns each user's credentials and cache. This does not perform
 * IdP discovery or sign a user in; the host owns its normal authentication.
 */
export function clientFromConnection(
    input: unknown,
    caller: ConnectionCaller = {},
    options: Pick<
        EzClassifyClientOptions,
        'heartbeat' | 'fetchImpl' | 'timeout' | 'disableCache'
    > = {},
): EzClassifyClient {
    const connection = readClientConnection(input);
    if (
        !object(caller) ||
        Object.keys(caller).some(
            (key) => !['user', 'attributes', 'auth'].includes(key),
        )
    )
        invalid();
    if (
        connection.userHeader
            ? (caller.user === undefined
                  ? connection.userRequired !== false
                  : !text(caller.user)) || caller.auth !== undefined
            : caller.user !== undefined
    )
        invalid();
    if (
        connection.auth
            ? !caller.auth && connection.auth.required !== false
            : caller.auth !== undefined
    )
        invalid();
    if (
        caller.attributes !== undefined &&
        (!object(caller.attributes) ||
            Object.keys(caller.attributes).length > 16 ||
            !Object.entries(caller.attributes).every(
                ([key, value]) =>
                    Object.hasOwn(connection.userHeaders ?? {}, key) &&
                    text(value),
            ))
    )
        invalid();
    if (
        caller.auth !== undefined &&
        (!object(caller.auth) ||
            Object.keys(caller.auth).some(
                (key) => !['token', 'onAuthFailure'].includes(key),
            ) ||
            !(
                text(caller.auth.token) ||
                typeof caller.auth.token === 'function'
            ) ||
            (caller.auth.onAuthFailure !== undefined &&
                typeof caller.auth.onAuthFailure !== 'function'))
    )
        invalid();
    const auth = caller.auth as ClientAuth | undefined;
    const dynamicHeaders: Record<string, string> = {};
    for (const [attribute, value] of Object.entries(caller.attributes ?? {}))
        dynamicHeaders[connection.userHeaders![attribute]!] = text(value)
            ? value
            : invalid();
    const headers = {
        ...connection.headers,
        ...dynamicHeaders,
        ...(connection.userHeader && text(caller.user)
            ? { [connection.userHeader.toLowerCase()]: caller.user }
            : {}),
    };
    return new EzClassifyClient(connection.baseUrl, {
        ...options,
        contextId: connection.contextId,
        contextVersion: connection.contextVersion,
        headers,
        ...(auth ? { auth } : {}),
    });
}
