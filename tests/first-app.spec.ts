import { describe, expect, it } from 'vitest';
// The distributed example is JavaScript so consumers can run it without a compiler.
// @ts-expect-error The example intentionally has no TypeScript declaration file.
import { readDocument } from '../examples/first-app/app.mjs';

describe('first application content boundary', () => {
    const document = {
        id: 'document',
        marking: 'CONFIDENTIAL',
        body: 'withheld content',
    };
    const subject = { id: 'user', attributes: {} };

    it.each([false, undefined, null, 'true', 1])(
        'withholds content without an explicit grant: %s',
        async (granted) => {
            const client = {
                context: { checkAccess: async () => ({ result: { granted } }) },
            };
            expect(await readDocument(client, document, subject)).toBeNull();
        },
    );

    it('does not return content when the runtime request fails', async () => {
        const client = {
            context: {
                checkAccess: async () => {
                    throw new Error('unavailable');
                },
            },
        };
        await expect(readDocument(client, document, subject)).rejects.toThrow(
            'unavailable',
        );
    });
});
