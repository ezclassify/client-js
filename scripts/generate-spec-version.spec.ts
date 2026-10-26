// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
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
import { stampSpecVersion } from './generate-spec-version.mjs';

/**
 * The spec-version stamp is regenerated before every build, test and typecheck.
 * A generated file rewritten with the bytes it already holds still looks edited
 * to anything that reads file times, so a test run alone made a finished build
 * look older than its source. The stamp is written only when its bytes change.
 */

/**
 * A throwaway repository holding a vendored spec at the given version.
 *
 * @param version - The `info.version` the spec declares.
 * @returns The repository root.
 */
function repository(version: string): string {
    const root = mkdtempSync(path.join(tmpdir(), 'spec-version-'));
    mkdirSync(path.join(root, 'vendor', 'spec'), { recursive: true });
    mkdirSync(path.join(root, 'src'));
    vendorSpec(root, version);
    return root;
}

/**
 * Write the vendored spec, as spec-sync would.
 *
 * @param root - The repository root.
 * @param version - The `info.version` the spec declares.
 */
function vendorSpec(root: string, version: string): void {
    writeFileSync(
        path.join(root, 'vendor', 'spec', 'openapi.yaml'),
        [
            'openapi: 3.1.0',
            'info:',
            '  title: EzClassify',
            `  version: ${version}`,
            'paths: {}',
            '',
        ].join('\n'),
        'utf8',
    );
}

const LONG_AGO = new Date('2020-01-01T00:00:00Z');

describe('generate-spec-version', () => {
    it('writes the stamp a fresh tree does not have yet', () => {
        const root = repository('1.2.3');
        expect(stampSpecVersion({ root })).toEqual({
            version: '1.2.3',
            written: true,
        });
        expect(
            readFileSync(path.join(root, 'src', 'spec-version.ts'), 'utf8'),
        ).toContain("export const CLIENT_SPEC_VERSION = '1.2.3';");
    });

    it('leaves a current stamp alone, file time included', () => {
        const root = repository('1.2.3');
        stampSpecVersion({ root });
        const stamp = path.join(root, 'src', 'spec-version.ts');
        utimesSync(stamp, LONG_AGO, LONG_AGO);

        expect(stampSpecVersion({ root })).toEqual({
            version: '1.2.3',
            written: false,
        });
        expect(statSync(stamp).mtimeMs).toBe(LONG_AGO.getTime());
    });

    it('rewrites the stamp when the vendored spec moves', () => {
        const root = repository('1.2.3');
        stampSpecVersion({ root });
        vendorSpec(root, '1.3.0');

        expect(stampSpecVersion({ root })).toEqual({
            version: '1.3.0',
            written: true,
        });
        expect(
            readFileSync(path.join(root, 'src', 'spec-version.ts'), 'utf8'),
        ).toContain("export const CLIENT_SPEC_VERSION = '1.3.0';");
    });
});
