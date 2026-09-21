# Evidence-bounded technical claim register

**Status:** engineering control for the `3.0.0+` release line
**Last reviewed:** 2026-09-21
**Owner:** BroccoliDB maintainers

This register is the boundary between what the repository can demonstrate and
what requires a measurement, an immutable publication record, or counsel. It is
not a patent claim set, invention assignment, novelty opinion, or freedom-to-
operate analysis.

## Status vocabulary

| Status | Meaning |
|---|---|
| `SOURCE-VERIFIED` | The statement is directly visible in the cited implementation or contract. |
| `TEST-BACKED` | A repository test exercises the stated behavior; the test scope still controls the claim. |
| `QUALIFIED` | The behavior exists, but a material limitation is part of the claim and must remain visible. |
| `MEASUREMENT-REQUIRED` | Do not publish a number or comparative performance statement without a reproducible benchmark record. |
| `LEGAL-REVIEW-REQUIRED` | Ownership, public-accessibility effect, novelty, patentability, FTO, or trademark conclusions are outside repository evidence. |

## Register

| ID | Bounded engineering statement | Evidence | Status | Required limit |
|---|---|---|---|---|
| C-001 | Tables keep records in process memory and maintain the implemented equality, sorted, composite, and prefix index structures. | `src/broccolidb-table.ts`, `src/broccolidb.contracts.ts` | `SOURCE-VERIFIED` | No latency, scale, or database-equivalence claim. |
| C-002 | Newly generated WAL frames carry checksum and prior-frame metadata; replay recomputes each checksum, validates a declared previous-frame link when present, and rejects malformed frame sequencing. | `src/broccolidb-wal.ts`, `test/broccolidb.test.ts` | `TEST-BACKED` | Legacy frames without link metadata remain readable; the checksum is unkeyed integrity evidence, not authentication or tamper-proofing. |
| C-003 | The current base checkpoint is a versioned JSON envelope that preserves application keys, carries a SHA-256 snapshot hash checked at startup, and is written to a temporary path before rename to `checkpoint.db`; legacy value-array snapshots remain readable. | `src/broccolidb-kernel.ts`, `src/broccolidb-table.ts`, `src/broccolidb.contracts.ts`, `test/broccolidb.test.ts` | `TEST-BACKED` | Replacement and crash behavior depend on the underlying filesystem; legacy records without embedded IDs cannot recover their original key; history writing, WAL rotation, and marker append are separate operations. |
| C-004 | Rollback validates on-disk snapshot shape/hash, restores records represented by an in-memory or on-disk checkpoint snapshot, and writes replayable reset frames before returning. | `src/broccolidb-kernel.ts`, `test/broccolidb.test.ts`, `docs/TROUBLESHOOTING.md` | `TEST-BACKED` | Tables created after the checkpoint are not removed automatically; this is not a distributed transaction. |
| C-005 | CAS `read()` accepts only a SHA-256-shaped identifier, rejects path-like identifiers before filesystem access, decompresses as needed, verifies the raw SHA-256 address, and quarantines decompression/hash failures. | `src/broccolidb-cas.ts`, `test/broccolidb.test.ts` | `TEST-BACKED` | `exists()` checks regular-file presence only; no encryption or availability guarantee. |
| C-006 | CAS pruning removes unreferenced valid blob files in one filesystem sweep and leaves temporary/non-blob entries outside that sweep. | `src/broccolidb-cas.ts`, `src/broccolidb-kernel.ts`, `test/broccolidb.test.ts` | `QUALIFIED` | The caller must provide a complete reference set; external manifests are not scanned. |
| C-007 | The mutex supports process-local async ownership, nested acquisition, queued waiters, and timeout errors. | `src/broccolidb-mutex.ts` | `SOURCE-VERIFIED` | A timeout is contention telemetry, not proof of a deadlock. |
| C-008 | The natural-query helper parses a constrained supported syntax without a network or model call. | `src/broccolidb-natural-query.ts`, `docs/API.md` | `SOURCE-VERIFIED` | It is not an LLM, general language parser, or AST performance claim. |
| C-009 | `health()` reports the current writeability, CAS metrics, WAL metrics including the last recorded WAL error, and table counters. | `src/broccolidb-kernel.ts`, `src/broccolidb.contracts.ts` | `QUALIFIED` | The `indexParity` field is explicitly unverified (`null`); this is not a full WAL replay, CAS scrub, index-parity scan, or cross-process check. |
| C-010 | Query and aggregation methods expose elapsed-time fields. | `src/broccolidb-table.ts`, `src/broccolidb-aggregation.ts` | `MEASUREMENT-REQUIRED` | Do not publish latency or throughput numbers without workload, runtime, hardware, and raw results. |
| C-011 | The repository identifies a steward and includes prospective license/provenance controls. | `NOTICE`, `DCO`, `CONTRIBUTING.md`, Git history | `LEGAL-REVIEW-REQUIRED` | Historical commits are not retroactively DCO-signed; do not infer complete chain of title, assignment, or contributor ownership from these files alone. |
| C-012 | A commit or archive may be useful evidence only after its public availability, exact contents, and date are independently preserved. | `docs/ip/INVENTION-DISCLOSURE-AND-PRIOR-ART.md`, USPTO MPEP § 2128 | `LEGAL-REVIEW-REQUIRED` | Do not call it legally sufficient prior art, proof of invalidity, or an FTO result. |
| C-013 | Startup treats only a missing base checkpoint as fresh state; read, JSON-parse, record-shape, and snapshot-hash failures raise `CheckpointIntegrityError`. | `src/broccolidb-kernel.ts`, `test/broccolidb.test.ts`, `docs/ARCHITECTURE.md` | `TEST-BACKED` | This fail-closed behavior does not repair corruption or create a backup; preserve the directory and restore from an inspected copy. |
| C-014 | The package dry-run contains the Apache/IP artifact set and excludes development/source/runtime-state surfaces. | `scripts/check-package-boundary.mjs`, `package.json`, `npm pack --dry-run` | `TEST-BACKED` | A local package-boundary check is evidence of the inspected artifact, not a registry publication record or supply-chain attestation. |

## Publication evidence packet

Before relying on a technical disclosure outside the repository, preserve all of
the following in an immutable release record:

1. exact Git object ID and remote URL;
2. public tag, release page, or archive URL with observed UTC timestamp;
3. SHA-256 digest of the source archive and package tarball;
4. source, `LICENSE`, `NOTICE`, SPDX metadata, and generated artifacts included
   in the archive;
5. Node.js/package-manager versions and exact build, test, and audit commands;
6. raw test output and any benchmark dataset, workload, and machine details;
7. an amendment record for later corrections rather than rewriting the original
   evidence packet.

The local baseline commit in the invention disclosure is a repository fact. It
is not, by itself, a verified public-disclosure date.

## Review gate

Run `npm run ip:check` whenever a source header, public documentation claim,
release artifact, or IP record changes. The check intentionally rejects old
marketing terms such as “cryptographic frame chaining,” “2-phase mark-sweep,”
“frame-perfect precision,” benchmark promises, and similar wording from public
claim surfaces.
