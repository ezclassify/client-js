#!/usr/bin/env node
/**
 * Guards the GitHub Packages mirror publish before it runs.
 *
 * The mirror carries prerelease versions only: `1.0.0-mirror.N`, never a plain
 * `1.0.0`. That has one consequence people get wrong exactly once. A dependency
 * range of `^1.0.0` does not match `1.0.0-mirror.7`, because npm excludes
 * prereleases from a range unless the range names one. So a package published
 * to the mirror while declaring `"@ezclassify/types": "^1.0.0"` installs
 * cleanly in the workspace that produced it and is unresolvable everywhere
 * else. The tarball looks right and no consumer can install it.
 *
 * Three checks:
 *
 * 1. This repository still publishes exactly one package. The publish workflow
 *    stamps and publishes the root package and nothing else. If workspaces
 *    appear here later, every new package would silently never reach the
 *    mirror, which is the kind of omission that shows up weeks later as a
 *    sibling repo's failed install.
 * 2. Every `@ezclassify/*` dependency range admits a mirror version. These all
 *    come from the contracts mirror at `1.0.0-mirror.N`, so each range has to
 *    be written `^1.0.0-0`.
 * 3. With `--expect-version <v>`, the package is actually at that version. The
 *    workflow stamps the mirror version and then calls this, so a stamp that
 *    did not land cannot put a plain `1.0.0` on a mirror that is not supposed
 *    to carry one.
 *
 * Run via: node scripts/check-mirror-publish.mjs [--expect-version <v>]
 *
 * Exits 1 with the specific package and field on any failure.
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const DEP_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];

const FIRST_PARTY_SCOPE = '@ezclassify/';

/**
 * A range npm will match against `1.0.0-mirror.N`.
 *
 * Not a general semver evaluation, and it should not be: the mirror stream is
 * exactly one shape, so the rule is that the caret range names a 1.0.0
 * prerelease. The exact version `1.0.0-0` does not match a mirror build.
 *
 * @param range - The dependency range as written in package.json.
 * @returns True when npm would resolve a mirror version through this range.
 */
function admitsMirrorVersion(range) {
    return /^\^1\.0\.0-0$/.test(range.trim());
}

/**
 * Audits the manifest the mirror publish is about to push.
 *
 * @param options - `root` is the repository root to read; `expectVersion`, when
 *   given, is the mirror version the package must already be stamped with.
 * @returns The package name, its version, and every problem found.
 */
export function auditMirrorPublish({
    root = repoRoot,
    expectVersion = null,
} = {}) {
    const problems = [];
    const manifestPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (pkg.private === true) {
        problems.push(
            `${pkg.name} is marked private, so the publish step would fail on it. A private package does not belong on the mirror.`,
        );
    }

    const workspaces = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : (pkg.workspaces?.packages ?? []);
    if (workspaces.length > 0) {
        problems.push(
            `package.json declares workspaces (${workspaces.join(', ')}), but .github/workflows/publish-mirror.yml stamps and publishes the root package only. Every workspace package would silently never reach the mirror. Teach the workflow the package list.`,
        );
    }

    for (const field of DEP_FIELDS) {
        for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
            if (!dep.startsWith(FIRST_PARTY_SCOPE)) continue;
            if (admitsMirrorVersion(range)) continue;
            problems.push(
                `${field}.${dep} is "${range}". The mirror publishes 1.0.0-mirror.N and npm will not match a prerelease against that range, so ${dep} would not resolve from the mirror and ${pkg.name} would be uninstallable off this machine. Use "^1.0.0-0".`,
            );
        }
    }

    if (expectVersion && pkg.version !== expectVersion) {
        problems.push(
            `package.json is at version ${pkg.version}, expected ${expectVersion}. The mirror version stamp did not reach it; publishing now would put a version on the mirror that is not part of the mirror stream.`,
        );
    }

    return { problems, name: pkg.name, version: pkg.version };
}

/**
 * Command-line entry point.
 *
 * @param argv - Arguments after the script path.
 * @returns A process exit code.
 */
function main(argv) {
    let expectVersion = null;
    const at = argv.indexOf('--expect-version');
    if (at !== -1) {
        expectVersion = argv[at + 1];
        if (!expectVersion) {
            console.error('--expect-version needs a version');
            return 2;
        }
    }

    const { problems, name, version } = auditMirrorPublish({ expectVersion });

    if (problems.length > 0) {
        console.error('Not safe to publish to the mirror:\n');
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error('');
        return 1;
    }

    console.log(`Mirror publish OK: ${name}@${version}, one package.`);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
