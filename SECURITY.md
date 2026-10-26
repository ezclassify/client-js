# Security Policy

## Supported Versions

| Version | Status             | Security Patches | End of Life |
| ------- | ------------------ | ---------------- | ----------- |
| 1.x     | Active development | Yes              | None        |

Only the latest patch release within each supported major version receives security updates. This repository publishes one package: `@ezclassify/rest-client`.

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Email **security@ezclassify.com** with the following information:

- Description of the vulnerability and its potential impact.
- Steps to reproduce the issue, including proof-of-concept if possible.
- Affected packages, versions, and configurations.
- Any suggested remediation, if available.

You will receive an acknowledgment within **48 hours**. We follow a **90-day coordinated disclosure** window from the date of the initial report.

## What Is a Security Issue

A security issue is a defect that could be exploited to compromise confidentiality, integrity, or availability. This package is an HTTP client: it holds no classification logic, so its exposure is what it sends, what it caches, and what it trusts from a response. Examples include:

- Leaking credentials or authorization headers into a log, an error message, a cache key, or a request to an origin other than the configured `baseUrl`.
- Prototype pollution or object injection while parsing a server response.
- A cached response served to a caller whose scheme, Context, or authorization differs from the one the entry was stored under.
- Following a redirect or a server-supplied path in a way that reaches an unintended origin.
- Denial of service through a crafted response that causes unbounded memory or CPU use in the client.
- A compromised or tampered package distribution path.

The following are **not** security issues and should be filed as regular bugs:

- Incorrect classification results, rollup logic errors, or an access decision you disagree with. Every one of those is decided server-side; file them on the [central EzClassify tracker](https://github.com/ezclassify/ezclassify/issues).
- Performance regressions that do not involve unbounded resource consumption.
- Missing validation that does not lead to exploitable behavior.
- Documentation errors.

If you are unsure whether something qualifies, report it to security@ezclassify.com and we will triage it.

## Response Timeline

| Stage                  | Timeline                         |
| ---------------------- | -------------------------------- |
| Acknowledgment         | Within 48 hours                  |
| Initial assessment     | Within 5 business days           |
| Patch development      | Within 30 days for critical/high |
| Coordinated disclosure | 90 days from initial report      |

If a fix is available before the 90-day deadline, we disclose upon release. If a fix is delayed, we negotiate an extended timeline with the reporter.

## Security Update Process

1. Reporter submits vulnerability through email.
2. We acknowledge receipt and assign a tracking identifier.
3. We assess severity using CVSS v3.1 scoring.
4. We develop and test a patch on a private branch.
5. We issue a CVE (if applicable) and publish a GitHub Security Advisory.
6. We release a patch version and notify downstream users via the advisory.
7. The advisory and CHANGELOG entry are published simultaneously with the fix.

## Security Scanning

- **Automated updates**: Dependabot monitors npm and GitHub Actions dependencies weekly and opens pull requests for known vulnerabilities.
- **Dependency auditing**: run `npm audit` locally before opening a pull request that adds or bumps dependencies.
- **Release verification**: npm releases are published only by the central release automation. npmjs.org signs every package version it publishes, and `npm audit signatures` checks after install that the files you received are the ones the registry published.

## Contact

For non-vulnerability security questions, reach us at security@ezclassify.com.
