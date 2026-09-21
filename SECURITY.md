# Security policy

## Supported versions

| Release line | Security-fix posture |
|---|---|
| `3.x` | Current release line; report issues privately before disclosure |
| `2.0.x` | Historical MIT line; no current security-support promise |

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Send a private report
to `willcruzdesigner@gmail.com` with:

- the affected version and commit or package artifact;
- a minimal reproduction or proof of concept;
- impact, prerequisites, and any known workaround; and
- whether the report may be shared with a coordinated-disclosure partner.

The maintainer will acknowledge receipt when practicable, preserve the report as
confidential security information, and coordinate a fix or disclosure timeline.
Do not include secrets, customer data, or credentials in the report.

## Scope and limits

The project does not promise a response time, a bounty, a security warranty, or
that a report will result in a particular CVE outcome. The package does not
encrypt state files or provide cross-process fencing; reports involving those
boundaries should state the deployment assumptions clearly.
