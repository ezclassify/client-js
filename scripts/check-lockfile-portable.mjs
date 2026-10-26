#!/usr/bin/env node
/**
 * Guards that the root `package-lock.json` stays environment-agnostic.
 *
 * `npm run deps:relock` normalizes first-party entries so the lockfile never
 * embeds a developer's local registry or a development mirror origin. Without
 * this check, an ordinary `npm install` on a dev machine silently reintroduces
 * a `localhost`/`127.0.0.1`/`:4873` URL, and nobody notices until CI or a
 * teammate's install breaks.
 *
 * First-party resolved URLs are environment-specific and are refused. Integrity
 * hashes carry no registry origin and are not a portability defect, so this
 * guard does not check them.
 *
 * Usage: node scripts/check-lockfile-portable.mjs [--lockfile=PATH]
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_PARTY_PREFIX = '@ezclassify/';
const MACHINE_LOCAL_RESOLVED = /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/)|:4873\b/;

function resolveLockfilePath() {
    const flag = process.argv
        .slice(2)
        .find((argument) => argument.startsWith('--lockfile='));
    return resolve(
        flag
            ? flag.slice('--lockfile='.length)
            : resolve(repositoryRoot, 'package-lock.json'),
    );
}

function nameFromLockfilePath(path) {
    const marker = 'node_modules/';
    const index = path.lastIndexOf(marker);
    if (index < 0) return null;
    return path.slice(index + marker.length);
}

function main() {
    const lockfilePath = resolveLockfilePath();
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const packages = lockfile.packages ?? {};
    const problems = [];

    for (const [path, entry] of Object.entries(packages)) {
        if (path === '') continue;
        const name = entry.name ?? nameFromLockfilePath(path);

        if (
            typeof entry.resolved === 'string' &&
            MACHINE_LOCAL_RESOLVED.test(entry.resolved)
        ) {
            problems.push(`${path} -> ${entry.resolved} (machine-local)`);
        }

        if (
            name &&
            name.startsWith(FIRST_PARTY_PREFIX) &&
            entry.link !== true &&
            'resolved' in entry
        ) {
            // `resolved` is an absolute URL naming the registry that served
            // this entry, so it is genuinely environment-specific and can
            // never be portable; see
            // this file's doc comment. `integrity` (a content hash) is
            // deliberately NOT checked here: it carries no environment
            // identity and pinning it is a security improvement, not a
            // portability defect.
            problems.push(
                `${path} pins a first-party origin; run \`npm run deps:relock\``,
            );
        }
    }

    if (problems.length > 0) {
        console.error(`${lockfilePath} is not portable across environments:`);
        for (const problem of problems) console.error(`  ${problem}`);
        process.exitCode = 1;
        return;
    }

    console.log(
        `${lockfilePath} is portable: no machine-local URLs, no pinned first-party origin.`,
    );
}

main();
