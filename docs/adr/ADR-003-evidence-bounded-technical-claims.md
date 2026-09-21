# ADR-003: Evidence-bounded technical and IP claims

- **Status:** Accepted
- **Date:** 2026-09-21
- **Owners:** BroccoliDB maintainers
- **Scope:** public documentation, source comments, release artifacts, and IP records

## Context

The first licensing/IP pass correctly added Apache-2.0, attribution, DCO,
SPDX, trademark, and defensive-disclosure controls. A second adversarial review
found that several inherited descriptions exceeded what the current source could
prove. Examples included continuous WAL chain language, two-phase garbage
collection, double-buffered checkpointing, forensic health claims, and
benchmark-level latency statements.

Overstated technical language weakens both engineering documentation and any
later provenance or prior-art review. A local Git timestamp also does not prove
that an internet disclosure was publicly accessible on that date.

## Decision

1. Describe implementation behavior at the narrowest level directly supported
   by source and tests.
2. Put material limitations next to the claim instead of hiding them in a
   separate disclaimer.
3. Keep `docs/ip/CLAIM-REGISTER.md` as the canonical bounded-claim inventory.
4. Require `npm run ip:check` through the repository's `npm run check` gate.
5. Classify ownership, chain of title, public-accessibility effect, novelty,
   patentability, FTO, and trademark conclusions as counsel-required matters.
6. Preserve immutable release evidence before using a disclosure in an external
   enforcement or patent conversation.

## Consequences

### Positive

- Public claims remain auditable against named source paths.
- Known limitations are visible to consumers and reviewers.
- Marketing language cannot silently reintroduce unsupported legal or technical
  conclusions without failing the local audit.
- Release owners have a repeatable evidence packet rather than a narrative based
  on file timestamps.

### Trade-offs

- The documentation is less promotional and cannot promise unmeasured latency,
  scale, durability, or patent effect.
- Some future claims require adding tests or a reproducible benchmark before they
  can be published.
- The automated gate is a repository control, not a substitute for counsel or a
  third-party integrity service.

## Alternatives considered

### Keep the inherited marketing terminology

Rejected because the source does not implement or verify every implied property.

### Add broad “not legal advice” text but retain absolute claims

Rejected because a disclaimer does not cure an inaccurate technical statement or
create public-accessibility evidence.

### Claim patent or copyright outcomes directly

Rejected. Those outcomes depend on facts, jurisdiction, filing history,
ownership, and professional legal analysis outside this repository.
