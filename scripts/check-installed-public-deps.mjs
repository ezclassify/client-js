/**
 * Audit installed dependencies against the public contracts-package allowlist.
 * Directory names and declared package names are both checked.
 *
 * @module
 */
import {
    existsSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';

// These packages are published from the public contracts repository. Keep the
// allowlist explicit: adding a name changes the public/private boundary.
const ALLOWED = new Set([
    '@ezclassify/conformance',
    '@ezclassify/conformance-server',
    '@ezclassify/openapi',
    '@ezclassify/tsconfig',
    '@ezclassify/types',
]);

function isDirectory(path) {
    return existsSync(path) && statSync(path).isDirectory();
}

/** Find disallowed first-party packages anywhere in an npm-installed tree. */
export function auditInstalledPublicDeps(root) {
    const firstNodeModules = join(root, 'node_modules');
    if (!isDirectory(firstNodeModules)) {
        throw new Error(
            `Installed node_modules tree is missing: ${firstNodeModules}`,
        );
    }

    const unexpected = [];
    const pending = [firstNodeModules];
    const visited = new Set();

    function inspectPackage(packagePath, name) {
        if (!isDirectory(packagePath)) return;
        const manifestPath = join(packagePath, 'package.json');
        const declaredName = JSON.parse(
            readFileSync(manifestPath, 'utf8'),
        ).name;
        if (typeof declaredName !== 'string' || declaredName.length === 0) {
            throw new Error(
                `Invalid installed package name in ${manifestPath}`,
            );
        }
        const directoryDenied =
            name.startsWith('@ezclassify/') && !ALLOWED.has(name);
        const declaredDenied =
            declaredName.startsWith('@ezclassify/') &&
            !ALLOWED.has(declaredName);
        if (directoryDenied || declaredDenied) {
            const location = relative(root, packagePath).split(sep).join('/');
            unexpected.push(
                name === declaredName
                    ? location
                    : `${location} (package name ${declaredName})`,
            );
        }
        const nested = join(packagePath, 'node_modules');
        if (isDirectory(nested)) pending.push(nested);
    }

    while (pending.length > 0) {
        const nodeModules = pending.pop();
        const realPath = realpathSync(nodeModules);
        if (visited.has(realPath)) continue;
        visited.add(realPath);

        for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const entryPath = join(nodeModules, entry.name);
            if (!isDirectory(entryPath)) continue;
            if (entry.name.startsWith('@')) {
                for (const scoped of readdirSync(entryPath, {
                    withFileTypes: true,
                })) {
                    inspectPackage(
                        join(entryPath, scoped.name),
                        `${entry.name}/${scoped.name}`,
                    );
                }
            } else {
                inspectPackage(entryPath, entry.name);
            }
        }
    }

    return unexpected.sort();
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        const unexpected = auditInstalledPublicDeps(process.cwd());
        if (unexpected.length > 0) {
            console.error('ERROR: unexpected @ezclassify packages installed:');
            for (const path of unexpected) console.error(`  ${path}`);
            process.exitCode = 1;
        } else {
            console.log('Installed @ezclassify packages are contracts-only.');
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
