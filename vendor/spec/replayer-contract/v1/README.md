# Replayer Contract v1

Every language SDK ships a ~50–80 LOC stub HTTP server (the "replayer") that
serves pre-recorded engine responses during conformance tests. Because the
replayer is written independently in each language, small differences in path
handling, header parsing, and JSON serialization can cause a conformance test
to pass or fail for the wrong reasons.

This corpus defines the **contract** every replayer must satisfy. Each
language's replayer MUST pass all cases in [`corpus.json`](corpus.json) before it is
permitted to run the engine-slice conformance suite.

---

## Envelope shape: miss

When no recording matches an incoming request the replayer MUST return:

```
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error":    "no_recording",
  "message":  "<human-readable, may vary>",
  "path":     "<normalized path, e.g. /api/scheme/process>",
  "bodyHash": "<sha256(stableJson(body)), lowercase hex>"
}
```

**Required fields:** `error`, `path`, `bodyHash`.  
**`message`** is informational; conformance harnesses MUST NOT assert on its exact value.  
**`error`** MUST be the literal string `"no_recording"`.

The conformance test harness detects this envelope and reports:

> no recording found for path=/api/scheme/process body={"input":"UNKNOWN-XYZ"}

instead of a silent subset-match failure.

---

## Lookup algorithm

The replayer is initialized with a map of `recordingKey → {statusCode, body}` pairs.

### Step 1: normalize the path

Strip one or more trailing slashes from the URL path.  
Path is **case-sensitive**; do not lowercase.

```
/api/scheme/process/  →  /api/scheme/process
/api/scheme/process   →  /api/scheme/process   (unchanged)
/api/scheme/PROCESS   →  /api/scheme/PROCESS   (unchanged)
```

### Step 2: normalize the request body

Compute `stableJson(body)`:

1. Parse the request body as JSON.
2. Walk the parsed value recursively.
3. For every **object** encountered, collect its keys, sort them
   lexicographically (byte order of the UTF-8 key string), and produce a new
   object with keys in that order.
4. **Arrays** are NOT reordered; only object keys are sorted.
5. Serialize the result as compact JSON (no spaces, no newlines).

`request.body` is the parsed semantic value in each corpus case. If a case also
has `request.rawBody`, send that string's UTF-8 bytes verbatim as the HTTP body
instead of serializing `request.body`. The two values must parse to the same
JSON. `arg-order` uses this field because JSON parser and serializer behavior
can otherwise erase the deliberately reversed wire-key order before the
request reaches the replayer.

```
Input:  {"schemeId":"ref-scheme-1","input":"MED"}
Output: {"input":"MED","schemeId":"ref-scheme-1"}
```

### Step 3: compute the lookup key

```
key = sha256( normalizedPath + "|" + stableJson(body) )
```

- Hash algorithm: SHA-256.
- Output: lowercase hexadecimal string (64 characters).
- The separator is the literal ASCII pipe character `|` (U+007C).
- There are no other separators.

**Example:**

```
normalizedPath = "/api/scheme/process"
stableJson     = {"input":"HIGH"}
hashInput      = /api/scheme/process|{"input":"HIGH"}
digest         = 1a3932ae1540cfe94df375cd61fc711aad550db874cb18e5a382ee39fff4ec3a
```

### Step 4: look up

Look up `digest` as the key in the recording map.

- **Hit:** return the recorded `statusCode` and `body` as JSON.
  Set `Content-Type: application/json`.
- **Miss:** return HTTP 404 with the miss envelope described above.
  Set `Content-Type: application/json`.

---

## Matching rules

| Rule                | Behavior                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Trailing slash      | Stripped from path before hashing                                                                        |
| Path case           | Preserved; changing letter case must miss a recording for the original path                              |
| Extra headers       | Ignored for lookup (`x-request-id`, `x-correlation-id`, etc.)                                            |
| `Content-Type`      | Accept any `application/json` media type including `application/json; charset=utf-8` or other parameters |
| Object key order    | Irrelevant; keys are sorted before hashing                                                               |
| Array element order | Significant; `["HIGH","MED"]` ≠ `["MED","HIGH"]`                                                         |
| Raw-byte comparison | Forbidden; always hash the stableJson form                                                               |

---

## Running the corpus against your replayer

The corpus is a self-contained JSON file ([`corpus.json`](corpus.json)). To run it:

1. For each case in [`corpus.json`](corpus.json) `.cases[]`:
   a. Start a fresh replayer instance initialized with the case's
   `replayerRecordings` map.
   b. Send the HTTP request described in `request` to the replayer.
      When `rawBody` is present, use its exact UTF-8 bytes for the request body.
   c. Assert that the response status equals `expectedStatus`.
   d. If `expectedStatus` is `200`, assert that the response body is a
   **subset-match** of `expectedBody` (every key in `expectedBody` must
   appear in the actual response with the same value; extra keys in the
   actual response are allowed).
   e. If `expectedStatus` is `404`, assert that the response body contains
   at minimum the fields in `expectedMissEnvelope` with matching values.
2. All cases must pass before the replayer may be used to run engine-slice
   conformance.

Subset-match semantics: for objects, every key in the expected value must be
present in the actual with an equal value (recursive); for arrays, every
element at position `i` in expected must subset-match `actual[i]`; for
primitives, strict equality.

---

## Hash reference values

Pre-computed keys for the corpus cases (for cross-language verification):

| Case                 | normalizedPath        | stableJson(body)                            | key              |
| -------------------- | --------------------- | ------------------------------------------- | ---------------- |
| exact-match          | `/api/scheme/process` | `{"input":"HIGH"}`                          | `1a3932ae...`    |
| trailing-slash       | `/api/scheme/process` | `{"input":"HIGH"}`                          | `1a3932ae...`    |
| extra-headers        | `/api/scheme/process` | `{"input":"HIGH"}`                          | `1a3932ae...`    |
| content-type-charset | `/api/scheme/process` | `{"input":"HIGH"}`                          | `1a3932ae...`    |
| arg-order            | `/api/scheme/process` | `{"input":"MED","schemeId":"ref-scheme-1"}` | `5e1ccd69...`    |
| array-order-hit      | `/api/scheme/process` | `{"inputs":["HIGH","MED"]}`               | `d6687093...`    |
| array-order-miss     | `/api/scheme/process` | `{"inputs":["MED","HIGH"]}`               | _(no recording)_ |
| path-case-miss       | `/api/scheme/PROCESS` | `{"input":"HIGH"}`                          | _(no recording)_ |
| miss-no-recording    | `/api/scheme/process` | `{"input":"UNKNOWN-XYZ"}`                   | _(no recording)_ |
| array miss bodyHash  | _(n/a)_               | `{"inputs":["MED","HIGH"]}`               | `0ae18627...`    |
| path miss bodyHash   | _(n/a)_               | `{"input":"HIGH"}`                          | `23c6ca75...`    |
| miss bodyHash        | _(n/a)_               | `{"input":"UNKNOWN-XYZ"}`                   | `344956ec...`    |

Full hashes are embedded in [`corpus.json`](corpus.json) next to each case.

---

## Conformance vocabulary

All values in this corpus use the scheme-agnostic test vocabulary
(`HIGH`, `MED`, `LOW`, `CTRL-A`). No domain-specific strings (TLP, CAPCO,
NATO, ICD-11, etc.) appear here. Scheme-specific values belong in scheme
content, not in this corpus.
