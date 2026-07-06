# Security Policy

## Supported Versions

This project tracks the latest commit on the `main` branch. Security fixes land
there — please make sure you are running the most recent version before
reporting an issue.

| Version | Supported |
| ------- | :-------: |
| `main` (latest) | ✅ |
| older commits   | ❌ |

## Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:

1. Open this repository's [**Security** tab](../../security).
2. Click [**Report a vulnerability**](../../security/advisories/new) to start a
   private security advisory.

> If the "Report a vulnerability" button isn't visible, a maintainer needs to
> enable **Private vulnerability reporting** under **Settings → Security**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible), and
- the affected version/commit and your environment.

You'll get an initial response on a best-effort basis. Once a fix is ready it is
released on `main` and the advisory is published.

## Deployment & Hardening Notes

This server bridges an MCP client to the **local** Anytype desktop API. Keep the
following in mind:

- **Your API key is a secret.** It lives in `.env`, which is git-ignored — never
  commit or share it. If it leaks, rotate it in **Anytype → Settings → API Keys**.
- **The HTTP endpoint is unauthenticated by default**, which is fine for
  localhost-only use. If you expose it beyond your machine, set `MCP_SHARED_TOKEN`
  and require it via an `Authorization: Bearer <token>` header or `?token=…`.
- **Keep the container on a trusted network.** Through its tools it can read and
  modify your Anytype data.
- **Keep dependencies current** (see Dependabot, if enabled).

Thank you for helping keep this project and its users safe.
