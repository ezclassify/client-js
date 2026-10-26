import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectContext } from '@ezclassify/rest-client';

/**
 * Return document content only after an explicit access grant. A refused or
 * failed request must never release content through the application's backend.
 *
 * @param {object} client - Connected EzClassify REST client.
 * @param {object} document - Stored marking and content.
 * @param {object} subject - Attributes supplied by the trusted identity
 *   adapter.
 * @returns {Promise<string | null>} Content for a grant, otherwise no content.
 */
export async function readDocument(client, document, subject) {
    const decision = await client.context.checkAccess(
        document.marking,
        subject.attributes,
        { audit: { userId: subject.id, resourceId: document.id } },
    );
    return decision.result.granted === true ? document.body : null;
}

/**
 * Exercise the same application workflow against the Cedar Valley replay server
 * or a real deployment. The workflow contains synthetic acceptance data, never
 * authoritative users.
 *
 * @param {object} connection - Runtime URL, immutable Context and optional
 *   credentials.
 * @param {object} workflow - Customer-approved synthetic grant and denial
 *   cases.
 * @param {(message: string) => void} [log] - Credential-free acceptance output.
 * @returns {Promise<void>} Resolves only when marking, grant and denial
 *   succeed.
 */
export async function runFirstApp(connection, workflow, log = console.log) {
    const client = await connectContext(connection);
    try {
        const processed = await client.scheme.process(workflow.marking);
        if (processed.valid !== true || !processed.rendered) {
            throw new Error('The acceptance marking was not valid');
        }
        const document = {
            id: workflow.resourceId,
            marking: processed.rendered,
            body: 'Synthetic onboarding document',
        };
        log(`Marking saved: ${document.marking}`);
        const allowed = await readDocument(client, document, {
            id: workflow.userId,
            attributes: workflow.allowedAttributes,
        });
        if (allowed !== document.body) {
            throw new Error('The approved grant case was denied');
        }
        log('Allowed reader: document returned');
        const denied = await readDocument(client, document, {
            id: workflow.userId,
            attributes: workflow.deniedAttributes,
        });
        if (denied !== null) {
            throw new Error('The approved denial case was granted');
        }
        log('Denied reader: document withheld');
    } finally {
        client.destroy();
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        const [connectionFile, workflowFile, credentialFile] =
            process.argv.slice(2);
        if (!connectionFile || !workflowFile) {
            throw new Error('Expected connection and workflow files');
        }
        const connection = JSON.parse(readFileSync(connectionFile, 'utf8'));
        if (credentialFile) {
            if (
                process.platform !== 'win32' &&
                (statSync(credentialFile).mode & 0o077) !== 0
            ) {
                throw new Error(
                    'Credential file must be readable only by its owner',
                );
            }
            const credentials = JSON.parse(
                readFileSync(credentialFile, 'utf8'),
            );
            if (!credentials.accessToken || !credentials.contextToken) {
                throw new Error(
                    'Both caller and Context credentials are required',
                );
            }
            connection.auth = { token: credentials.accessToken };
            connection.contextToken = credentials.contextToken;
        }
        await runFirstApp(
            connection,
            JSON.parse(readFileSync(workflowFile, 'utf8')),
        );
    } catch {
        console.error(
            'Onboarding check failed. Check the connection, credential expiry and approved test cases. No document is released on a failed access request.',
        );
        process.exitCode = 1;
    }
}
