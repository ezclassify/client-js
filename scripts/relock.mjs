#!/usr/bin/env node
/**
 * Two-step, date-bounded relock for the root `package-lock.json`.
 *
 * A fresh `npm install` resolves whatever version currently matches each
 * devDependency range, so fast-moving packages land inside any quarantine
 * window as a matter of course, and `check:dependency-age` would go red on
 * unrelated changes. So the tree is pinned: CI runs `npm ci` against a lockfile
 * that was itself produced under the quarantine window, and first-party entries
 * are normalized so the lockfile never embeds a developer's local registry.
 *
 * `npm run deps:relock` runs all three phases in order:
 *
 * 0. (caller runs `rm -rf node_modules package-lock.json`) `npm install
 *    --package-lock-only --before=X` only applies `--before` while actually
 *    resolving a package against the registry. If EITHER an existing
 *    `package-lock.json` entry OR an existing `node_modules` copy already
 *    satisfies a dependency's range, npm carries that version forward
 *    unfiltered and never consults `--before` for it, so the bound is inert
 *    whenever the tree it runs against is already populated. Only removing BOTH
 *    forces npm to re-resolve every package from the registry, where `--before`
 *    actually applies.
 * 1. --strip delete every `@ezclassify/*` dependency from every package.json in
 *    this workspace (root + each workspace member), backing each one up first.
 *    Third-party ranges are left untouched.
 * 2. (caller runs `npm install --package-lock-only --before=<7d ago>`) With
 *    first-party ranges gone, npm resolves ONLY third-party packages, and
 *    `--before` bounds every one of them to the quarantine window.
 * 3. --restore put every package.json back.
 * 4. (caller runs `npm install --package-lock-only`, no bound) First-party ranges
 *    resolve again. npm is lockfile-preferring, so this does not change any
 *    third-party version already pinned in step 2; it only adds the first-party
 *    entries back.
 *
 *    The unbounded pass carries `--tag=dev`. npm takes the version under its
 *    default dist-tag whenever that version satisfies the range, ahead of the
 *    highest one, and development builds are tagged `dev`. The bounded pass
 *    keeps npm's default, so every third-party version it locks is chosen
 *    without the tag.
 * 5. --normalize strip `resolved` and `integrity` from every first-party lockfile
 *    entry, so the lockfile carries no machine-local registry URL and no
 *    integrity hash tied to one development build. `npm ci` then resolves those
 *    entries through whichever `@ezclassify:registry` the installing
 *    environment configures.
 *
 * First-party packages can be served by different registries in different
 * environments, `resolved` is an absolute URL naming one of them, and there is
 * no rewrite that turns a URL for one registry into a URL for the other, so a
 * lockfile has to stay origin-free.
 *
 * Usage: node scripts/relock.mjs --strip|--restore|--normalize [--root=PATH]
 *
 * @module
 */
import {
    existsSync,
    globSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
);
const rootArgument = process.argv.find((argument) =>
    argument.startsWith('--root='),
);
const repositoryRoot = rootArgument
    ? resolve(process.cwd(), rootArgument.slice('--root='.length))
    : defaultRepositoryRoot;
const lockfilePath = resolve(repositoryRoot, 'package-lock.json');

const FIRST_PARTY_PREFIX = '@ezclassify/';
const DEPENDENCY_FIELDS = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
];
const BACKUP_SUFFIX = '.relock-backup';

const mode = process.argv.find((argument) =>
    ['--strip', '--restore', '--normalize'].includes(argument),
);

/**
 * Every package.json this repository could resolve `@ezclassify/*` ranges from:
 * the root manifest plus one level under each glob in the root `workspaces`
 * array, if it declares any.
 */
function workspacePackageJsonPaths() {
    const root = resolve(repositoryRoot, 'package.json');
    const rootManifest = JSON.parse(readFileSync(root, 'utf8'));
    const paths = [root];
    for (const glob of rootManifest.workspaces ?? []) {
        for (const match of globSync(resolve(repositoryRoot, glob))) {
            const memberManifest = resolve(match, 'package.json');
            if (existsSync(memberManifest)) paths.push(memberManifest);
        }
    }
    return paths;
}

function strip() {
    for (const path of workspacePackageJsonPaths()) {
        const original = readFileSync(path, 'utf8');
        const backupPath = path + BACKUP_SUFFIX;
        writeFileSync(backupPath, original);

        const manifest = JSON.parse(original);
        let changed = false;
        for (const field of DEPENDENCY_FIELDS) {
            const deps = manifest[field];
            if (!deps) continue;
            for (const name of Object.keys(deps)) {
                if (name.startsWith(FIRST_PARTY_PREFIX)) {
                    delete deps[name];
                    changed = true;
                }
            }
        }
        // With nothing stripped, the backup is identical to the original and
        // restore() no-ops it.
        if (changed) {
            writeFileSync(path, JSON.stringify(manifest, null, 4) + '\n');
            console.log(`stripped @ezclassify/* ranges from ${relative(path)}`);
        }
    }
}

function restore() {
    for (const path of workspacePackageJsonPaths()) {
        const backupPath = path + BACKUP_SUFFIX;
        if (!existsSync(backupPath)) continue;
        renameSync(backupPath, path);
        console.log(`restored ${relative(path)}`);
    }
}

function normalize() {
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const packages = lockfile.packages ?? {};
    let normalized = 0;
    for (const [path, entry] of Object.entries(packages)) {
        if (path === '') continue;
        const name = entry.name ?? nameFromLockfilePath(path);
        if (!name || !name.startsWith(FIRST_PARTY_PREFIX)) continue;
        if (entry.link === true) continue; // workspace symlink, nothing to strip
        let touched = false;
        if ('resolved' in entry) {
            delete entry.resolved;
            touched = true;
        }
        if ('integrity' in entry) {
            delete entry.integrity;
            touched = true;
        }
        if (touched) normalized += 1;
    }
    writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 4) + '\n');
    console.log(
        `normalized ${normalized} first-party lockfile entr${normalized === 1 ? 'y' : 'ies'} (dropped resolved/integrity)`,
    );
}

function nameFromLockfilePath(path) {
    const marker = 'node_modules/';
    const index = path.lastIndexOf(marker);
    if (index < 0) return null;
    return path.slice(index + marker.length);
}

function relative(path) {
    return path.startsWith(repositoryRoot)
        ? path.slice(repositoryRoot.length + 1)
        : path;
}

switch (mode) {
    case '--strip':
        strip();
        break;
    case '--restore':
        restore();
        break;
    case '--normalize':
        normalize();
        break;
    default:
        console.error(
            'Usage: node scripts/relock.mjs --strip|--restore|--normalize [--root=PATH]',
        );
        process.exitCode = 1;
}
