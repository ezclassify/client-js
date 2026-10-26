/**
 * Access to the golden wire corpus: the recorded request and response pairs
 * every EzClassify SDK replays through its own client.
 *
 * The corpus is not authored. Each entry came back over a socket from a real
 * runtime answering a real request, and was validated against the OpenAPI
 * contract as it was recorded. Replaying it is how this client proves it puts
 * the same bytes on the wire the runtime already answered, without a mock
 * server standing in as a second implementation of the contract.
 *
 * The corpus is read from `vendor/spec/`, beside the contract it was recorded
 * against.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusCase } from '@ezclassify/conformance-server';

const here = dirname(fileURLToPath(import.meta.url));

/** The vendored corpus and its provenance. */
const VENDORED_CORPUS = resolve(here, '../vendor/spec/wire/v1/corpus.json');
const VENDORED_MANIFEST = resolve(here, '../vendor/spec/wire/v1/manifest.json');

/** The vendored contract the client is compiled against. */
const VENDORED_SPEC = resolve(here, '../vendor/spec/openapi.yaml');

/** One recorded exchange, as the corpus carries it. */
export type WireCase = CorpusCase;

/** A corpus document plus its provenance. */
export interface LoadedWireCorpus {
    /** Absolute path the corpus was read from. */
    file: string;
    /** Corpus format version, as the artifact declares it. */
    corpusVersion: string;
    /** Every recorded exchange, in corpus order. */
    cases: WireCase[];
    /** Recorded exchanges by case id. */
    byId: Map<string, WireCase>;
    /** Provenance beside the corpus, or null when it could not be read. */
    manifest: WireCorpusManifest | null;
}

/** The provenance document the corpus ships with. */
export interface WireCorpusManifest {
    /** The contract digest the recording was validated against. */
    spec?: { digest?: string; infoVersion?: string };
    /** Places the recorded runtime and the published contract disagree. */
    contractDivergences?: Array<{
        caseId: string;
        subject: string;
        keyword: string;
        property?: string;
        note: string;
    }>;
    /** What the recording run covered. */
    coverage?: { cases?: number; operationsCovered?: number };
}

/**
 * Read the vendored corpus.
 *
 * @returns The corpus and its provenance
 */
export function loadWireCorpus(): LoadedWireCorpus {
    const file = VENDORED_CORPUS;
    const manifestFile = VENDORED_MANIFEST;

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        corpusVersion?: string;
        cases?: WireCase[];
    };
    if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
        throw new Error(
            `${file} declares no cases, so there is nothing to replay`,
        );
    }

    let manifest: WireCorpusManifest | null = null;
    try {
        manifest = JSON.parse(
            readFileSync(manifestFile, 'utf8'),
        ) as WireCorpusManifest;
    } catch {
        manifest = null;
    }

    return {
        byId: new Map(parsed.cases.map((entry) => [entry.id, entry])),
        cases: parsed.cases,
        corpusVersion: parsed.corpusVersion ?? 'unknown',
        file,
        manifest,
    };
}

/**
 * The manifest's contract divergences, as sortable one-line keys.
 *
 * A divergence is a place the recorded runtime and the published contract
 * disagree. The manifest carries them so the harness can tell a known
 * disagreement from a new one. Keys rather than whole records, because `note`
 * is prose: rewording an explanation should not read as a new divergence, while
 * a new case, subject, keyword or property should.
 *
 * @param manifest - The provenance document beside the corpus, or null
 * @returns One `caseId subject keyword property` line per divergence, sorted. A
 *   divergence about the whole subject rather than one property keys as `*`.
 */
export function divergenceKeys(manifest: WireCorpusManifest | null): string[] {
    return (manifest?.contractDivergences ?? [])
        .map((entry) =>
            [
                entry.caseId,
                entry.subject,
                entry.keyword,
                entry.property ?? '*',
            ].join(' '),
        )
        .sort();
}

/**
 * SHA-256 of the vendored contract, in the `sha256:<hex>` form the corpus
 * manifest records.
 *
 * The corpus is a recording of one contract answering. Replaying it against a
 * client compiled from a different contract proves nothing about either, so the
 * two digests are compared rather than assumed equal.
 *
 * @returns The digest of `vendor/spec/openapi.yaml`
 */
export function vendoredSpecDigest(): string {
    return `sha256:${createHash('sha256').update(readFileSync(VENDORED_SPEC)).digest('hex')}`;
}
