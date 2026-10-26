import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The conformance-server lane: the same corpus, over real HTTP, against
 * `@ezclassify/conformance-server`. Split out of the default run because it
 * boots a server and binds a port.
 */
export default defineConfig({
    test: {
        root: __dirname,
        include: ['tests/integration/**/*.spec.ts'],
        environment: 'node',
        globals: false,
    },
});
