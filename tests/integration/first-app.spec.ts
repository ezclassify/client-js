import { readFileSync } from 'node:fs';
import { startConformanceServer } from '@ezclassify/conformance-server';
import { expect, it } from 'vitest';
// @ts-expect-error The distributed JavaScript example needs no compiler at the customer.
import { runFirstApp } from '../../examples/first-app/app.mjs';

it('runs the distributed application against Cedar Valley over real HTTP', async () => {
    const server = await startConformanceServer({
        scenario: 'cedar-valley',
        port: 0,
        log: null,
    });
    const workflow = JSON.parse(
        readFileSync(
            new URL(
                '../../examples/first-app/workflow.cedar-valley.json',
                import.meta.url,
            ),
            'utf8',
        ),
    );
    const output: string[] = [];
    try {
        await runFirstApp(
            {
                baseUrl: server.url,
                contextId: 'cedar-valley',
                contextVersion: '1.0.0',
            },
            workflow,
            (line: string) => output.push(line),
        );
        expect(output).toEqual([
            'Marking saved: CONFIDENTIAL',
            'Allowed reader: document returned',
            'Denied reader: document withheld',
        ]);
    } finally {
        await server.stop();
    }
});
