import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';

const pkg = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as {
    name: string;
    version: string;
};

/**
 * Write a minimal package.json to dist/lib so published consumers can resolve
 * entry points.
 */
function distPackageJson(): Plugin {
    return {
        name: 'dist-package-json',
        closeBundle() {
            writeFileSync(
                'dist/lib/package.json',
                JSON.stringify(
                    {
                        name: pkg.name,
                        version: pkg.version,
                        type: 'module',
                        main: './index.cjs',
                        module: './index.mjs',
                        types: './index.d.ts',
                        exports: {
                            '.': {
                                types: './index.d.ts',
                                import: './index.mjs',
                                require: './index.cjs',
                            },
                        },
                    },
                    null,
                    2,
                ) + '\n',
            );
        },
    };
}

export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.ts',
            formats: ['es', 'cjs'],
            fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
        },
        outDir: 'dist/lib',
        emptyOutDir: true,
        rollupOptions: {
            external: (id) =>
                id.startsWith('node:') || id.startsWith('@ezclassify/'),
        },
        sourcemap: true,
        target: 'node22',
    },
    plugins: [dts({ tsconfigPath: './tsconfig.lib.json' }), distPackageJson()],
});
