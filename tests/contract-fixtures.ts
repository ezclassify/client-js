/**
 * Contract-valid response bodies for tests that stub the transport.
 *
 * The client refuses a 200 that lacks a member the contract requires, so a stub
 * answering `{ rendered: '' }` stops being a stand-in for a response. The
 * recorded corpus holds a real one for every operation; these helpers hand back
 * an independent copy so a test can change what it cares about and leave the
 * rest valid.
 */

import { loadWireCorpus } from './wire-corpus';

const corpus = loadWireCorpus();

/**
 * The whole recorded response body of a corpus case.
 *
 * @param caseId - Corpus case id
 * @returns A deep copy the caller may change
 */
export function corpusBody<T = Record<string, unknown>>(caseId: string): T {
    const recorded = corpus.byId.get(caseId);
    if (!recorded) throw new Error(`no corpus case with the id ${caseId}`);
    return structuredClone(recorded.response.body) as T;
}

/**
 * The `result` member of a recorded Context envelope.
 *
 * @param caseId - Corpus case id
 * @returns A deep copy the caller may change
 */
export function corpusResult<T = Record<string, unknown>>(caseId: string): T {
    return (corpusBody(caseId) as { result: T }).result;
}
