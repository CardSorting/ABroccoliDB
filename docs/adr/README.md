# Architecture decision records

Architecture Decision Records (ADRs) capture decisions that affect the public
API, durable formats, portability boundary, or recovery behavior. They are
shorter than a whitepaper and more durable than a changelog entry.

## Index

| ID | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-portable-inmemory-kernel.md) | Use a portable in-memory table kernel with explicit filesystem durability | Accepted |
| [ADR-002](ADR-002-apache-licensing-and-ip-protection.md) | Move future releases to Apache-2.0 with provenance, patent, and trademark controls | Accepted |
| [ADR-003](ADR-003-evidence-bounded-technical-claims.md) | Bound technical and IP claims by source evidence, tests, measurements, and legal review | Accepted |
| [ADR-004](ADR-004-recovery-and-integrity-boundaries.md) | Fail closed on damaged recovery state and constrain integrity-sensitive paths | Accepted |

## When to write an ADR

Write or update an ADR when a change:

- adds/removes a public export;
- changes WAL, checkpoint, CAS, or recovery semantics;
- changes the runtime dependency or native-module policy;
- changes concurrency or cross-process assumptions;
- introduces a new persistence format or compatibility decision.

Do not use an ADR for a typo, a local refactor, or a test-only fixture change.

## Lifecycle

1. Create the next numbered file from [the template](TEMPLATE.md).
2. State context, decision, alternatives, consequences, and compatibility impact.
3. Link it from this index and the affected reference/operations documents.
4. Mark it `Accepted`, `Superseded`, or `Rejected`; do not silently rewrite the
   historical decision.

## Status vocabulary

- **Proposed** — under review and not yet a supported contract.
- **Accepted** — current supported decision.
- **Superseded** — replaced by a later ADR; retain for history.
- **Rejected** — considered and declined; retain the reasoning.
