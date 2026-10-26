# Connect your app to EzClassify

This example saves a marking with a document and checks access before it
releases the content. It runs unchanged in three places: against the Cedar
Valley replay server on your machine, against your runtime, and against the
Context for your purchased policy.

Cedar Valley is a fictional school district policy for teaching. Use only
synthetic documents and test identities with it. Its markings do not govern
real information.

## Start with the Cedar Valley replay server

The replay server answers over real HTTP with responses recorded from a real
runtime for `cedar-valley@1.0.0`. You need Node.js 22 or 24 and npm. You do not
need a runtime, a license or a credential.

In a new application directory, run:

```sh
npm init -y
npm install --save-exact @ezclassify/rest-client@1.0.0 @ezclassify/conformance-server@1.0.0
cp -R node_modules/@ezclassify/rest-client/examples/first-app ./first-app
npx @ezclassify/conformance-server --scenario cedar-valley --port 4010
```

Leave the server running. In a second terminal, in the same directory, run the
app:

```sh
node first-app/app.mjs first-app/connection.replay.json first-app/workflow.cedar-valley.json
```

It prints:

```text
Marking saved: CONFIDENTIAL
Allowed reader: document returned
Denied reader: document withheld
```

The app processes the marking, saves the normalized result with an in-memory
synthetic document, and asks the server before it returns the content. A denial
returns nothing. A connection, authentication or response failure stops the
check. Your application will use its database instead of the in-memory
document.

If port 4010 is taken, start the server on another port and change `baseUrl` in
`first-app/connection.replay.json` to match.

The server replays a fixed set of recorded requests, so keep the supplied
workflow file as it is. Any other request gets a 501 diagnostic, not an
invented answer. It cannot check a new policy or authenticate real users.

Inside an air gap, your platform team supplies the packages through an approved
internal registry or an offline npm cache. Use the npm configuration and
install command they give you.

## Switch to your runtime

Same code. A different connection file and credentials. The people who run
your runtime (your platform team) give you:

- A runtime URL, with `cedar-valley@1.0.0` approved for your app organization.
- `connection.cedar-valley.json` with that URL, the Context ID and the exact
  version.
- The path to a protected credential file.

The connection file looks like this:

```json
{
    "baseUrl": "https://runtime.agency.example",
    "contextId": "cedar-valley",
    "contextVersion": "1.0.0"
}
```

The credential file holds two tokens. The caller token identifies your backend
and comes from your identity provider. The Context token authorizes your app to
use that exact Context version, and your platform team issues it.

```json
{
    "accessToken": "<caller identity token>",
    "contextToken": "<signed token for your app and Cedar Valley>"
}
```

Keep credentials out of connection files, source control, browser code and
logs. On Linux or macOS the credential file must be readable only by its owner
(`0600`); the app refuses to run otherwise. On Windows, restrict it with an ACL
to the application identity.

Node must trust your runtime's TLS certificate. For an agency CA, launch Node
with `NODE_EXTRA_CA_CERTS` pointing at the CA file your platform team supplies.
Certificate verification stays on.

Run the app with the real connection file and your credential file:

```sh
node first-app/app.mjs connection.cedar-valley.json first-app/workflow.cedar-valley.json /protected/ezclassify-credentials.json
```

You get the same three lines. This time the request reaches your runtime, with
identity, Context authorization and decision auditing turned on. The subject
attributes in the workflow file are still synthetic, so this proves your
connection and enforcement path, not your production identity mapping.

If it fails, send your platform team the time, runtime URL, app organization
and Context ID and version. They check enrollment, publication, credential
expiry, TLS and audit settings. Do not send them credentials or document
content.

## Use your purchased policy

Your agency's own policy, built on the scheme it purchased, runs as an
application Context on the same runtime. The agency can update that policy
locally without sending it to the seller. Same runtime URL, same code.

Your policy author and platform team give you:

- `connection.application.json` and `workflow.application.json`.
- A Context token for your app and the exact Context version.
- An approved valid test marking, plus synthetic grant and denial cases.

Replace `contextToken` in the protected credential file with the new token. The
Cedar Valley token does not authorize the application's Context. Make sure
`accessToken` is still valid for the same app organization, then run:

```sh
node first-app/app.mjs connection.application.json workflow.application.json /protected/ezclassify-credentials.json
```

The workflow file uses the same fields as [`workflow.cedar-valley.json`](workflow.cedar-valley.json):
`marking`, `userId`, `resourceId`, `allowedAttributes` and `deniedAttributes`.
Fill them with the approved synthetic values. Changing the Context selects
different policy. It does not translate Cedar Valley markings into agency
markings.

The check passes when the approved marking, the grant and the denial all behave
under your Context. You changed no code on the way here.

## Put it into your application

Copy the pattern in [`app.mjs`](app.mjs). Process a marking and require `valid: true`.
Save the normalized marking with the document. Call `context.checkAccess`
before you release it, and release content only when
`decision.result.granted === true`. Any failure releases nothing. Make this
check in your backend on every protected read, including downloads and
alternate routes.

Take the subject from your server-side identity adapter, never from the
browser. It returns `{ id, attributes }` from a verified session or an approved
attribute service. `id` is the stable user reference for decision auditing.
`attributes` is the exact policy input mapping your agency approved. Missing
required attributes must produce a denial, and an invalid session must stop
before the runtime call. Send the subject and document references in
`context.audit.userId` and `context.audit.resourceId`, and apply your
retention and privacy rules to them. Have the agency approve the identity
source, the subject reference, the attribute mapping and the
missing-attribute behavior before production.

A protected read looks like this:

```js
// Your identity adapter validates the session and the approved claims.
const subject = await identityAdapter.requireVerifiedSubject(request);
const content = await readDocument(client, storedDocument, subject);
if (content === null) {
    return response.status(403).end();
}
return response.send(content);
```

`readDocument` is the function in [`app.mjs`](app.mjs). Handle a thrown identity or
runtime error without returning content.

The two credentials do different jobs. The caller token says who your backend
is. The Context token says which policy versions it may use. Your app never
receives Studio administrator credentials or signing keys.

This example reads the credential file on each run. A long-running backend can
read it on each request, using the SDK's supplier form for both tokens:

```js
import { readFileSync } from 'node:fs';
import { connectContext } from '@ezclassify/rest-client';

const credentials = () =>
    JSON.parse(readFileSync('/protected/ezclassify-credentials.json', 'utf8'));
const client = await connectContext({
    ...connection,
    auth: { token: () => credentials().accessToken },
    contextToken: () => credentials().contextToken,
});
```

Your identity provider integration renews the caller token and your platform
team renews the Context token. Replace the credential file atomically before
either expires. The app identity and Context binding stay fixed for a client,
so a different binding needs a new client. Call `destroy()` on shutdown. An
unreadable file or a refused credential must stop protected reads, and cached
policy never authorizes an expired credential. Monitor renewal failures and
expirations.
