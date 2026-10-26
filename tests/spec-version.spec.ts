import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { CLIENT_SPEC_VERSION } from '../src/spec-version';
import { mockResponse, stubFetch } from './fetch-mock';

// Replicate the same major.minor extraction logic as the private _majorMinor
// in ezclassify-client.ts so we can derive fixture wire versions dynamically.
// This helper is NOT what's under test: it's test-fixture setup only.
function majorMinor(v: string): string {
    const parts = v.split('.');
    return `${parts[0] ?? '0'}.${parts[1] ?? '0'}`;
}

const SPEC_MAJOR_MINOR = majorMinor(CLIENT_SPEC_VERSION);
const [specMajorStr, specMinorStr] = SPEC_MAJOR_MINOR.split('.');
const specMinorNum = parseInt(specMinorStr ?? '0', 10);

// Wire version with same major.minor but different patch → compatible (no warn)
const MATCHING_WIRE = `${specMajorStr}.${specMinorStr}.999`;
// Wire version with bumped minor → incompatible (warn)
const MISMATCHED_WIRE = `${specMajorStr}.${specMinorNum + 1}.0`;

// ---------------------------------------------------------------------------
// 1. CLIENT_SPEC_VERSION shape
// ---------------------------------------------------------------------------

describe('CLIENT_SPEC_VERSION', () => {
    it('is a non-empty string', () => {
        expect(typeof CLIENT_SPEC_VERSION).toBe('string');
        expect(CLIENT_SPEC_VERSION.length).toBeGreaterThan(0);
    });

    it('matches full semver pattern (major.minor.patch)', () => {
        expect(CLIENT_SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('is returned by engineSpecVersion()', () => {
        const c = new EzClassifyClient('https://api.example.com');
        expect(c.engineSpecVersion()).toBe(CLIENT_SPEC_VERSION);
    });
});

// ---------------------------------------------------------------------------
// 2. Version compatibility via ping(): warn / no-warn paths
// ---------------------------------------------------------------------------

describe('spec-version compatibility via ping()', () => {
    let fetchStub: ReturnType<typeof stubFetch>;

    beforeEach(() => {
        fetchStub = stubFetch();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function healthBody(engineVersion: string): string {
        return JSON.stringify({
            status: 'ok',
            engineVersion,
            engineSha: 'abc',
            gitTag: '',
        });
    }

    async function pingWith(
        engineVersion: string,
    ): Promise<{ warned: boolean; msg: string | undefined }> {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchStub.mockResolvedValueOnce(
            mockResponse(200, healthBody(engineVersion)),
        );
        const c = new EzClassifyClient('https://api.example.com');
        await c.ping();
        const warned = warnSpy.mock.calls.length > 0;
        const msg = warned ? (warnSpy.mock.calls[0][0] as string) : undefined;
        warnSpy.mockRestore();
        return { warned, msg };
    }

    it('no warning when wire major.minor matches spec', async () => {
        const { warned } = await pingWith(MATCHING_WIRE);
        expect(warned).toBe(false);
    });

    it('no warning for same-major.minor with pre-release suffix', async () => {
        // '0.1.0-rc.1' → split('.') = ['0','1','0-rc','1'] → majorMinor '0.1'
        const preRelease = `${SPEC_MAJOR_MINOR}.0-rc.1`;
        const { warned } = await pingWith(preRelease);
        expect(warned).toBe(false);
    });

    it('no warning when wire version is two-part (major.minor, no patch)', async () => {
        // '0.1' → split('.') = ['0','1'] → majorMinor '0.1'
        const { warned } = await pingWith(SPEC_MAJOR_MINOR);
        expect(warned).toBe(false);
    });

    it('warns when wire minor is bumped', async () => {
        const { warned } = await pingWith(MISMATCHED_WIRE);
        expect(warned).toBe(true);
    });

    it('warning message names both the client spec version and the wire version', async () => {
        const { warned, msg } = await pingWith(MISMATCHED_WIRE);
        expect(warned).toBe(true);
        expect(msg).toContain(CLIENT_SPEC_VERSION);
        expect(msg).toContain(MISMATCHED_WIRE);
        expect(msg).toMatch(/Mixed minor versions are unsupported/);
    });

    it('warning fires only once across repeated pings', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchStub
            .mockResolvedValueOnce(
                mockResponse(200, healthBody(MISMATCHED_WIRE)),
            )
            .mockResolvedValueOnce(
                mockResponse(200, healthBody(MISMATCHED_WIRE)),
            );
        const c = new EzClassifyClient('https://api.example.com');
        await c.ping();
        await c.ping();
        expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('ping returns engineVersion, engineSha, and gitTag from the health response', async () => {
        fetchStub.mockResolvedValueOnce(
            mockResponse(
                200,
                JSON.stringify({
                    status: 'ok',
                    engineVersion: MATCHING_WIRE,
                    engineSha: 'deadbeef',
                    gitTag: 'v0.1.999',
                }),
            ),
        );
        const c = new EzClassifyClient('https://api.example.com');
        const result = await c.ping();
        expect(result.engineVersion).toBe(MATCHING_WIRE);
        expect(result.engineSha).toBe('deadbeef');
        expect(result.gitTag).toBe('v0.1.999');
    });
});

// ---------------------------------------------------------------------------
// 3. _majorMinor parsing edge cases
//
// The private _majorMinor is exercised indirectly: ping() warns iff
//   majorMinor(CLIENT_SPEC_VERSION) !== majorMinor(engineVersion)
// so for each (wire, expectedMajorMinor) pair we predict warn = (expectedMajorMinor !== SPEC_MAJOR_MINOR).
// ---------------------------------------------------------------------------

describe('_majorMinor parsing edge cases (via ping warn/no-warn)', () => {
    let fetchStub: ReturnType<typeof stubFetch>;

    beforeEach(() => {
        fetchStub = stubFetch();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function warnedFor(engineVersion: string): Promise<boolean> {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchStub.mockResolvedValueOnce(
            mockResponse(
                200,
                JSON.stringify({
                    status: 'ok',
                    engineVersion: engineVersion,
                    engineSha: '',
                    gitTag: '',
                }),
            ),
        );
        const c = new EzClassifyClient('https://api.example.com');
        await c.ping();
        const warned = warnSpy.mock.calls.length > 0;
        warnSpy.mockRestore();
        return warned;
    }

    it('three-part semver: extracts major.minor, ignores patch', async () => {
        const wire = '1.2.3';
        const warned = await warnedFor(wire);
        expect(warned).toBe(majorMinor(wire) !== SPEC_MAJOR_MINOR);
    });

    it('two-part semver, no patch segment: extracts correctly', async () => {
        const wire = '1.2';
        const warned = await warnedFor(wire);
        expect(warned).toBe(majorMinor(wire) !== SPEC_MAJOR_MINOR);
    });

    it('prerelease tag: suffix after third dot does not affect major.minor', async () => {
        const wire = '1.2.3-alpha.1';
        const warned = await warnedFor(wire);
        expect(warned).toBe(majorMinor(wire) !== SPEC_MAJOR_MINOR);
    });

    it('prerelease with build metadata: extracts same as bare prerelease', async () => {
        const wire = '0.1.0-rc.2+build.456';
        const warned = await warnedFor(wire);
        expect(warned).toBe(majorMinor(wire) !== SPEC_MAJOR_MINOR);
    });

    it('only major present: minor defaults to "0"', async () => {
        // majorMinor('1') = '1.0'; never matches a real SPEC_MAJOR_MINOR like '0.1'
        const wire = '1';
        const warned = await warnedFor(wire);
        expect(warned).toBe(majorMinor(wire) !== SPEC_MAJOR_MINOR);
    });

    it('empty string: produces ".0", does not throw', async () => {
        // majorMinor('') = '.0'; never matches a real spec version
        const warned = await warnedFor('');
        expect(warned).toBe(true);
    });

    it('no dots at all: whole string becomes major, minor defaults to "0"', async () => {
        // majorMinor('notver') = 'notver.0'; never matches a real spec version
        const warned = await warnedFor('notver');
        expect(warned).toBe(true);
    });
});
