/**
 * Cache conformance: every plan in the shared cache contract, run against the
 * recorded wire corpus.
 *
 * `CACHE-SEMANTICS.md` is the cross-SDK contract and `plans.json` beside it is
 * the executable form every SDK runs. The rules are asserted at the transport,
 * through the real client, in wire trips: a port that reproduces the cache's
 * structure but emits a different number of requests fails here, and the number
 * of requests is the part an integrator can measure.
 * `tests/request-cache.spec.ts` covers the cache as a data structure.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020';
import { loadWireCorpus } from './wire-corpus';
import {
    CAPABILITIES,
    driverKeys,
    runPlan,
    type PlanFile,
    type PlanStep,
} from './cache-plan-runner';

const here = dirname(fileURLToPath(import.meta.url));
const cacheDirectory = resolve(here, '../vendor/spec/cache/v1');
const plans = JSON.parse(
    readFileSync(resolve(cacheDirectory, 'plans.json'), 'utf8'),
) as PlanFile;
const schema = JSON.parse(
    readFileSync(resolve(cacheDirectory, 'plans.schema.json'), 'utf8'),
) as object;
const corpus = loadWireCorpus();

/** Every operation and case pair a plan names in a call or concurrent step. */
function namedPairs(): Array<[operation: string, caseId: string]> {
    const pairs = new Map<string, [string, string]>();
    for (const plan of plans.plans) {
        for (const step of plan.steps as PlanStep[]) {
            if (step.step === 'call' || step.step === 'concurrent') {
                pairs.set(`${step.operation}|${step.case}`, [
                    step.operation,
                    step.case,
                ]);
            }
        }
    }
    return [...pairs.values()];
}

describe('cache conformance: the plan file', () => {
    it('is valid against its schema', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const valid = ajv.validate(schema, plans);
        expect(valid, ajv.errorsText(ajv.errors)).toBe(true);
    });

    it('names the corpus this client replays', () => {
        expect(resolve(cacheDirectory, plans.corpus)).toBe(corpus.file);
    });

    it('has a driver for every operation and case a plan calls, and none left over', () => {
        const named = namedPairs().map(
            ([operation, caseId]) => `${operation}|${caseId}`,
        );
        expect(driverKeys().sort()).toEqual(named.sort());
    });

    it('names only cases the corpus recorded', () => {
        const known = new Set(corpus.cases.map((entry) => entry.id));
        const unknown = namedPairs()
            .map(([, caseId]) => caseId)
            .filter((caseId) => !known.has(caseId));
        expect(unknown).toEqual([]);
    });

    it('measures every exchange the corpus marks as never cached', () => {
        const measured = new Set(namedPairs().map(([, caseId]) => caseId));
        const marked = corpus.cases
            .filter((entry) => entry.neverCache !== undefined)
            .map((entry) => entry.id);
        expect(marked.filter((id) => !measured.has(id))).toEqual([]);
    });

    it('covers every checklist item', () => {
        const covered = new Set(plans.plans.flatMap((plan) => plan.covers));
        expect(
            plans.checklist
                .map((item) => item.id)
                .filter((id) => !covered.has(id)),
        ).toEqual([]);
    });

    it('declares every capability the plans require, with none not applicable', () => {
        const required = new Set(
            plans.plans.flatMap((plan) => plan.capabilities),
        );
        expect([...required].filter((name) => !CAPABILITIES[name])).toEqual([]);
        expect(Object.keys(CAPABILITIES).sort()).toEqual(
            Object.keys(plans.capabilities).sort(),
        );
    });
});

describe('cache conformance: plans', () => {
    for (const plan of plans.plans) {
        it(`${plan.id} [${plan.covers.join(', ')}]: ${plan.title}`, async () => {
            await runPlan(plan, plans);
        });
    }
});
