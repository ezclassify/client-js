import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'vendor/**',
            '**/*.d.ts',
            '**/*.js',
            '**/*.mjs',
            '**/*.cjs',
        ],
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            // `_name` marks a binding that is deliberately not used. It has to
            // cover destructured variables as well as arguments: connectContext
            // destructures `metadata: _metadata` purely to drop it from the
            // options forwarded to the server.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
];
