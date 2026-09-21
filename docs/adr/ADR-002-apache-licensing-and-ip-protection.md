# ADR-002: Apache licensing and defensive IP protection

- **Status:** Accepted
- **Date:** 2026-09-21
- **Owners:** William Andrew Cruz / CardSorting
- **Scope:** package licensing, attribution, contribution provenance, and project IP records

## Context

BroccoliDB `2.0.1` was published under the MIT License. MIT is simple and
adoption-friendly, but it does not contain an express patent grant, patent
retaliation condition, or Apache-style NOTICE and trademark framework. The
LUMI-NEW project uses those mechanisms as part of its defensive IP strategy.

The standalone package is already published. A license change therefore cannot
rewrite the rights granted to recipients of `2.0.x`; the repository needs a
clear release boundary and a machine-checkable way to keep future artifacts
consistent.

## Decision

Starting with `3.0.0`, the package and repository distribution are licensed
under the unmodified Apache License, Version 2.0 (`Apache-2.0`). The project
also adopts:

- a project `NOTICE` with copyright, maintainer, dependency, and trademark
  attribution information;
- a defensive patent and IP policy that points to the operative Apache patent
  terms without trying to amend them;
- a separate trademark/naming policy, because the Apache code license grants
  no trademark permission;
- a dated, evidence-oriented `docs/ip/` record for technical provenance and
  possible prior-art preservation;
- DCO 1.1 sign-off for contribution provenance; and
- SPDX headers plus `npm run license:check` to catch metadata, NOTICE, package,
  and source-header drift before release.

The project does not add a non-commercial, anti-competitive, field-of-use, or
custom patent restriction to Apache-2.0. Apache-2.0 still permits commercial
use and closed larger works. A desire to prohibit those uses requires a
separate counsel-reviewed source-available or dual-license release strategy;
it cannot be achieved by a README notice while Apache-2.0 remains the grant.

## Alternatives considered

### Keep MIT

Rejected for the `3.0.0` line. MIT remains the historical license for `2.0.x`,
but the new release should provide a clearer patent and attribution framework.

### Use MPL-2.0 or AGPL-3.0

Not selected for this migration. Both would impose reciprocal source-sharing
obligations that change how consumers embed this library. They may be valid
future strategies if preserving modified source is more important than the
current embedded-library adoption model, but they are not the LUMI-compatible
strategy requested here.

### Write a custom “no commercial use” license

Rejected without legal counsel. Custom field-of-use, competition, training,
and SaaS restrictions create ambiguity, are not open-source licenses, and can
conflict with npm and dependency expectations. If exclusivity is required, it
should be a separately versioned commercial/source-available product decision,
with a professionally reviewed license and a documented dual-license chain of
title.

### Use a copyright assignment or broad commercial CLA immediately

Deferred. DCO establishes provenance but does not transfer copyright or give
the steward a right to relicense another contributor’s work under proprietary
terms. Any future assignment or relicensing agreement must be explicit,
voluntary, and reviewed for the contributor and project’s actual jurisdictions.

## Consequences

### Positive

- Existing MIT recipients keep the permissions they already received.
- Future recipients get Apache-2.0’s express contributor patent grant and
  defensive patent termination.
- Copyright, NOTICE, modification, and trademark requirements are visible in
  the source tree and published package.
- DCO, SPDX, release metadata, and automated checks support an auditable record
  from contribution to package artifact.
- The project avoids making unsupported claims about patent validity,
  inventorship, or public-disclosure effect.

### Trade-offs

- Apache-2.0 does not prevent commercial forks or closed larger works.
- Contributors retain copyright under the DCO; this is not a copyright
  assignment or automatic proprietary-relicensing grant.
- Consumers and release automation must carry NOTICE and policy files.
- A major release boundary is needed even though the runtime API is unchanged,
  because license and compliance behavior changed.

## Compatibility impact

- Runtime API, on-disk formats, and production dependencies are unchanged.
- `2.0.x` remains MIT; `3.0.0+` is Apache-2.0.
- `package.json`, `package-lock.json`, README badges, package `files`, NOTICE,
  and release notes must agree.
- Re-distributors must follow the Apache-2.0 conditions, including preserving
  applicable notices and marking modified files.
