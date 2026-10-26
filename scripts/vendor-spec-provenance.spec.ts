// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Verify the vendored contract's source identity and content hashes without
 * pinning the test to one commit. The native spec writer owns these files.
 */
const ROOT = path.resolve(__dirname, '..');

/**
 * Read a repository file as text.
 *
 * @param relativePath - Path relative to the repository root.
 * @returns File contents.
 */
function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

interface VendorManifest {
    openapiVersion?: string;
    openapiSha256?: string;
    specBundleSha256?: string;
    specDigest?: string;
    contractsSha?: string;
    sourcePackages?: Record<string, string>;
    [key: string]: unknown;
}

const manifest = JSON.parse(
    read('vendor/spec/MANIFEST.json'),
) as VendorManifest;
const specMarkdown = read('vendor/SPEC.md');

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('vendored spec provenance', () => {
    it('names contracts as the source commit', () => {
        expect(manifest.contractsSha).toMatch(SHA1_HEX);
    });

    it('names the contracts packages the bundle was built from', () => {
        const packages = manifest.sourcePackages;
        expect(packages, 'sourcePackages block').toBeTypeOf('object');
        const names = Object.keys(packages ?? {});
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(name, 'source package name').toMatch(/^@ezclassify\//);
            expect(packages?.[name], `${name} version`).toMatch(/^\d+\.\d+\./);
        }
    });

    it('records content hashes that are actually hashes', () => {
        expect(manifest.openapiSha256).toMatch(SHA256_HEX);
        expect(manifest.specBundleSha256).toMatch(SHA256_HEX);
        expect(manifest.specDigest).toMatch(SHA256_HEX);
    });

    it('records the hash of the openapi.yaml that is actually committed', () => {
        const actual = createHash('sha256')
            .update(readFileSync(path.join(ROOT, 'vendor/spec/openapi.yaml')))
            .digest('hex');
        expect(manifest.openapiSha256).toBe(actual);
    });

    it('records the openapi version the committed spec declares', () => {
        const raw = read('vendor/spec/openapi.yaml');
        const declared = raw.match(/^ {2}version:\s+(\S+)/m)?.[1];
        expect(declared, 'info.version in openapi.yaml').toBeDefined();
        expect(manifest.openapiVersion).toBe(declared);
    });
});

describe('vendored SPEC.md provenance table', () => {
    /**
     * Pull a value out of the two-column provenance table in SPEC.md.
     *
     * @param field - The row label, without the surrounding backticks.
     * @returns The row's value cell, trimmed of whitespace and backticks.
     */
    function provenanceRow(field: string): string | undefined {
        const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = specMarkdown.match(
            new RegExp(`^\\|\\s*\`${escaped}\`\\s*\\|([^|]*)\\|`, 'm'),
        );
        return match?.[1].replace(/`/g, '').trim();
    }

    it('has a contracts@ source row', () => {
        expect(provenanceRow('contracts@')).toMatch(SHA1_HEX);
    });

    it('agrees with MANIFEST.json about the source commit', () => {
        // Two files, one fact. They are written in the same pass, so a
        // disagreement means the writer half-applied a change.
        expect(provenanceRow('contracts@')).toBe(manifest.contractsSha);
    });

    it('points specSourceUrl at the contracts repo at that commit', () => {
        const url = provenanceRow('specSourceUrl');
        expect(url).toContain('github.com/ezclassify/contracts');
        expect(url).toContain(manifest.contractsSha);
    });
});

describe('vendor-readonly gate wiring', () => {
    const workflow = read('.github/workflows/vendor-readonly.yml');

    it('fires on push, not only on pull_request', () => {
        // Spec commits can land by direct push as well as through a pull
        // request, so both triggers are required.
        expect(workflow).toMatch(/^ {2}pull_request:$/m);
        expect(workflow).toMatch(/^ {2}push:$/m);
    });

    it('watches the same paths on both triggers', () => {
        const blocks = workflow.match(/^ {4}paths:\n(?: {6}(?:#.*|- .*)\n)+/gm);
        expect(blocks?.length, 'paths blocks').toBe(2);
        const globsOf = (block: string): string[] =>
            block
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.startsWith('- '))
                .map((line) => line.slice(2).replace(/'/g, ''));
        expect(globsOf(blocks![0])).toEqual(globsOf(blocks![1]));
    });

    it('names the spec bot and contracts as the writer and source', () => {
        expect(workflow).toContain('ezclassify-spec-bot');
        expect(workflow).toContain('ezclassify/contracts');
    });

    it('classifies a branch-creation push as a fallback reason', () => {
        // The spec bot creates `chore/spec-update-<sha>` and pushes it, and
        // GitHub reports before=000... for that. Text can only establish that
        // the zero-SHA case is classified as a fallback reason; whether the
        // push is actually admitted is proven by running the gate, in
        // vendor-readonly-gate.spec.ts.
        const resolveStep = workflow.slice(
            workflow.indexOf('- name: Resolve the commit range'),
            workflow.indexOf('- name: Enforce bot identity'),
        );
        expect(resolveStep, 'range-resolution step').not.toHaveLength(0);
        expect(resolveStep).toContain(
            'REASON="branch creation: this push has no pre-push commit"',
        );
    });

    // The behavioral half of this gate's coverage, what the workflow DOES
    // when it runs, is in scripts/vendor-readonly-gate.spec.ts, which
    // executes the workflow's own `run:` bodies against purpose-built git
    // history. That file and this one are both discovered through the
    // `scripts/**` entry in vitest.config.mjs, so neither can notice its own
    // absence. tests/spec-discovery.spec.ts holds that from outside.

    it('falls back with --is-ancestor rather than a string comparison', () => {
        // `origin/<default> != HEAD` is true even when HEAD is an ancestor of
        // origin/<default>, and `origin/<default>..HEAD` is EMPTY in that
        // case. An inequality would hand the gate an empty commit set and it
        // would pass having read nothing.
        // Assert the specific guard, not the mere presence of the phrase.
        // `--is-ancestor` appears twice in this workflow; only this one stops
        // the fallback range resolving empty.
        expect(workflow).toContain(
            '! git merge-base --is-ancestor "$HEAD_SHA" "$FALLBACK"',
        );
    });

    it('reads the single-commit fallback with diff-tree, not a walking log', () => {
        // `git log -1 <sha> -- vendor/...` WALKS to the nearest ancestor that
        // touched those paths, so on a HEAD that touches nothing it reports a
        // commit that was never in the push.
        expect(workflow).toContain('git diff-tree --no-commit-id --name-only');
        expect(workflow).not.toMatch(
            /git log -1 "\$HEAD_SHA".*\n?.*-- 'vendor/,
        );
    });

    it('is not disarmed by continue-on-error or an always() condition', () => {
        expect(workflow).not.toContain('continue-on-error');
        expect(workflow).not.toContain('if: always()');
    });
});
