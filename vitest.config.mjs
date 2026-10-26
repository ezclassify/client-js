import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        root: __dirname,
        include: ['tests/**/*.spec.ts', 'scripts/**/*.spec.ts'],
        // The conformance-server lane binds a port and boots a real server, so
        // it is its own script (`npm run test:conformance-server`) rather than
        // part of the default run. See vitest.integration.mjs.
        exclude: ['tests/integration/**'],
        environment: 'node',
        globals: false,
    },
});
