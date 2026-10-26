// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Why `prepublishOnly` is in package.json when npm will not run it here.
 *
 * This repository's `.npmrc` sets `ignore-scripts=true`, which suppresses npm's
 * own lifecycle hooks along with dependencies', so as an npm hook the key is
 * inert. It stays because a publication-boundary tarball scan seeds its walk
 * from the three publish lifecycle keys (`prepublishOnly`, `prepack`,
 * `prepare`), follows `npm run` from there, and opens the bundler config each
 * command implies. That walk is how it reaches `vite build`, and through it
 * `vite.config.ts`, which keeps `@ezclassify/*` imports out of the published
 * bundle. With no lifecycle key declared the walk starts nowhere and inspects
 * no build at all. `npm run <name>` is not suppressed by `ignore-scripts`, so
 * on that path the script genuinely runs.
 *
 * These assertions are a local tripwire on the manifest property that walk
 * depends on.
 */
const ROOT = path.resolve(__dirname, '..');

/** The three keys the tarball scan seeds its walk from. */
const PUBLISH_LIFECYCLE = ['prepublishOnly', 'prepack', 'prepare'];

const scripts =
    (
        JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
        }
    ).scripts ?? {};

/**
 * Every script reachable from the publish lifecycle by following `npm run`.
 *
 * The traversal the tarball scan performs, reduced to the part this repository
 * can assert on its own.
 *
 * @returns Script names, including the lifecycle keys themselves.
 */
function reachableScripts(): Set<string> {
    const seen = new Set<string>();
    const queue = [...PUBLISH_LIFECYCLE];
    while (queue.length > 0) {
        const name = queue.shift() as string;
        if (seen.has(name)) continue;
        seen.add(name);
        const body = scripts[name];
        if (typeof body !== 'string') continue;
        for (const match of body.matchAll(/npm run ([\w:.-]+)/g)) {
            queue.push(match[1]);
        }
    }
    return seen;
}

/**
 * The command bodies of every reachable script that is actually defined.
 *
 * @returns Script bodies, in no particular order.
 */
function reachableBodies(): string[] {
    return [...reachableScripts()]
        .map((name) => scripts[name])
        .filter((body): body is string => typeof body === 'string');
}

describe('publish-lifecycle declaration', () => {
    it('declares prepublishOnly, which is what the tarball scan seeds from', () => {
        expect(
            scripts.prepublishOnly,
            'package.json must declare "prepublishOnly". The tarball scan ' +
                'starts its walk at this key; without it the scan reaches no ' +
                'build script, opens no bundler config, and passes having ' +
                'inspected nothing. It is a declaration the publish tooling ' +
                "reads, not an npm hook: .npmrc's ignore-scripts=true stops " +
                'npm running it here.',
        ).toBeTypeOf('string');
    });

    it('reaches the bundler command from the lifecycle, through npm run', () => {
        const bodies = reachableBodies();
        expect(bodies.length, 'reachable script bodies').toBeGreaterThan(0);
        expect(
            bodies.some((body) => /\bvite build\b/.test(body)),
            'No script reachable from the publish lifecycle runs `vite build`. ' +
                'The scan follows `npm run` from the lifecycle keys and opens ' +
                'the config the bundler command implies; break that chain and ' +
                'vite.config.ts belongs to no program the scan can see.',
        ).toBe(true);
    });

    it('has the bundler config the command never names', () => {
        // `vite build` names no file. The scan finds vite.config.ts by
        // convention, so the convention has to hold.
        expect(existsSync(path.join(ROOT, 'vite.config.ts'))).toBe(true);
    });

    it('keeps the whole @ezclassify scope external in that config', () => {
        // The one thing standing between a private package and a published
        // bundle. It is a predicate on the scope prefix, so it names no
        // package: a name-based scan reads this file the same with the
        // predicate and without it, and only its presence is evidence.
        const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
        expect(config).toMatch(/\bexternal\b[\s\S]{0,300}?@ezclassify/);
    });
});
