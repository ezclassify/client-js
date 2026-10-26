# Agent Instructions

## Standards

Read [`STANDARDS.md`](./STANDARDS.md) before any feature, refactor,
architectural decision, or task longer than 30 minutes. These engineering
standards apply to you as they do to any contributor. Skip for quick bug fixes,
typos, and documentation-only changes.

Read [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the command set and the
vendored-spec workflow.

## What this repository is

One package, `@ezclassify/rest-client`: a thin HTTP client for a running EzClassify
REST deployment. It carries no engine and makes no classification decision of
its own. Every semantic answer comes from the server.

## Two rules that are not negotiable

1. **No proprietary dependency, ever.** This repository is public and
   Apache-2.0. It may depend on third-party packages and on what the
   [ezclassify/contracts](https://github.com/ezclassify/contracts) repository publishes: `@ezclassify/types` and
   `@ezclassify/tsconfig` for the build, `@ezclassify/conformance` and
   `@ezclassify/conformance-server` for the wire corpus in tests, and
   `@ezclassify/openapi` for wire types in tests and request validation in the
   replay server. It may not depend on
   `@ezclassify/engine` or any other private package: not in `dependencies`,
   not in `devDependencies`, not vendored, not in a tracked `dist`. The only
   knowledge this side has of the private side is the public REST contract in
   [`vendor/spec/`](vendor/spec/). The `No proprietary dependency crept in` job in
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs [`scripts/check-installed-public-deps.mjs`](scripts/check-installed-public-deps.mjs)
   against the installed tree. Its five-name allowlist is explicit in that
   script; the reason for each name is in the workflow. Widening the list is a
   deliberate change to both places, reviewed in the open.
2. **[`vendor/`](vendor/) is read-only here.** It is written by the spec bot from the
   [ezclassify/contracts](https://github.com/ezclassify/contracts) repository. Change the source, not the copy.
