/**
 * Corpus replay: every recorded exchange this client's surface can reach,
 * driven through the real client against a transport that will answer nothing
 * else.
 *
 * It catches a wire regression in seconds, and it does it without a second
 * implementation of the contract for the client to agree with.
 */

import { describe, it, expect } from 'vitest';
import {
    divergenceKeys,
    loadWireCorpus,
    vendoredSpecDigest,
} from './wire-corpus';
import { ReplayTransport } from './wire-replay-transport';
import type { DriverOutcome } from './wire-drivers';
import {
    EXCLUDED_CASES,
    WIRE_DRIVERS,
    buildReplayClient,
} from './wire-drivers';

const corpus = loadWireCorpus();

describe('wire corpus provenance', () => {
    it('was recorded against the contract this client is compiled from', () => {
        expect(corpus.manifest?.spec?.digest).toBe(vendoredSpecDigest());
    });

    it('is read from the same vendored bundle as the contract', () => {
        expect(corpus.file).toMatch(/vendor\/spec\/wire\/v1\/corpus\.json$/);
    });
});

describe('wire corpus contract divergences', () => {
    // Pin the empty set so a newly recorded divergence fails the suite.
    it('carries the known set and no others', () => {
        // A missing manifest must not masquerade as zero divergences.
        expect(corpus.manifest).not.toBeNull();
        expect(divergenceKeys(corpus.manifest)).toEqual([]);
    });
});

describe('wire corpus coverage', () => {
    it('accounts for every recorded case', () => {
        const driven = new Set(
            Object.values(WIRE_DRIVERS).flatMap((driver) => [...driver.cases]),
        );
        const unaccounted = corpus.cases
            .map((entry) => entry.id)
            .filter((id) => !driven.has(id) && !(id in EXCLUDED_CASES));
        expect(
            unaccounted,
            'these recorded exchanges are neither driven nor excluded. Add a driver, ' +
                'or document why this client cannot emit the request.',
        ).toEqual([]);
    });

    it('accounts only for cases the corpus carries', () => {
        const known = new Set(corpus.cases.map((entry) => entry.id));
        const claimed = [
            ...Object.values(WIRE_DRIVERS).flatMap((driver) => [
                ...driver.cases,
            ]),
            ...Object.keys(EXCLUDED_CASES),
        ];
        expect(claimed.filter((id) => !known.has(id))).toEqual([]);
    });

    it('claims each case exactly once', () => {
        const claimed = [
            ...Object.values(WIRE_DRIVERS).flatMap((driver) => [
                ...driver.cases,
            ]),
            ...Object.keys(EXCLUDED_CASES),
        ];
        const seen = new Set<string>();
        const duplicated = claimed.filter((id) => {
            if (seen.has(id)) return true;
            seen.add(id);
            return false;
        });
        expect(duplicated).toEqual([]);
    });
});

describe('wire corpus replay', () => {
    for (const [name, driver] of Object.entries(WIRE_DRIVERS)) {
        it(`${name}: ${driver.cases.join(', ')}`, async () => {
            const transport = new ReplayTransport(
                corpus,
                driver.cases,
                driver.assertRequest,
            );
            const client = buildReplayClient(driver.binding, transport.fetch);
            let outcome: DriverOutcome;
            try {
                outcome = {
                    settled: 'resolved',
                    value: await driver.run(client),
                };
            } catch (error) {
                outcome = { settled: 'rejected', error };
            } finally {
                client.destroy();
            }

            transport.assertEveryCaseEmitted();
            driver.verify(outcome, (caseId) => transport.recorded(caseId));
        });
    }
});
