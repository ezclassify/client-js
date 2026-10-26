# Contributing to the EzClassify JavaScript client

Thanks for your interest in contributing. This page is the process contract. For
environment setup, the command set, and the vendored-spec workflow, see
[`DEVELOPMENT.md`](DEVELOPMENT.md).

## Before You Start

1. **Sign off your commits.** Contributions come in under the Developer
   Certificate of Origin, so every commit carries a `Signed-off-by` line.
   `git commit -s` adds it. There is no agreement to sign and nothing to send:
   see the [DCO text](https://github.com/ezclassify/ezclassify/blob/main/DCO.md) for what the line certifies.
2. **Fork the repository.** All contributions come through pull requests from
   forks.
3. **Open an issue first** for non-trivial changes.

## Pull Request Expectations

- **Bring tests.** New behavior needs tests; a bug fix needs a regression test
  that fails without the fix. The suite is Vitest (`npm test`).
- **Stay thin.** This package speaks HTTP to a running deployment. It holds no
  classification logic of its own, and a change that starts deciding something
  locally rather than asking the server belongs somewhere else.
- **Read the standards.** Engineering standards for design, code quality,
  testing, and decision-making are in [`STANDARDS.md`](STANDARDS.md); read it
  before any significant work.

## Commit Messages

Conventional commits (`fix:`, `feat:`, `docs:`). Sign off each one with
`git commit -s`.

## Security

Do not open public issues for vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md) for the disclosure process.

## Code of Conduct

This project follows the [Code of Conduct](https://github.com/ezclassify/ezclassify/blob/main/CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
