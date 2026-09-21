# BroccoliDB technical disclosure and prior-art record

**Document ID:** `IP-2026-09-20-BROCCOLIDB-01`
**Status:** Engineering disclosure; legal review not performed
**Repository baseline:** first standalone-package commit `e1040a8` (2026-09-20)
**Steward shown by repository history:** William Andrew Cruz (`CardSorting`)
**Public disclosure date:** verify against the public repository or an immutable release archive before relying on it

## Purpose and limits

This record identifies the technical mechanisms present in the standalone
BroccoliDB package and points to evidence that can be inspected. It preserves a
dated engineering description in the style used by LUMI-NEW, but it does not
assert inventorship, novelty, patentability, priority, or freedom to operate.
It also does not claim that every idea or dependency in the implementation is
owned by the steward. Chain-of-title and third-party prior art require separate
review.

## Disclosed technical mechanisms

### 1. Table-first in-memory state with secondary indexes

`BroccoliDbTable` keeps records in process memory, maintains equality, sorted,
composite, and prefix index structures, and exposes deterministic filters,
ordering, pagination, TTL expiration, snapshots, and change events.

**Evidence:** `src/broccolidb-table.ts`, `src/broccolidb.contracts.ts`, and
the table/query sections of `test/broccolidb.test.ts`.

### 2. Micro-batched WAL with per-frame checksums

`BroccoliWriteAheadLog` serializes mutation frames, includes prior-frame hash
metadata in the checksum input, flushes buffered frames, recomputes each frame
checksum during replay, validates a declared `previousFrameHash` against the
immediately preceding checksum when present, and rejects frame-sequence gaps.
The mechanism is designed for an explicit file-backed durability boundary rather
than a server process. Legacy frames without link metadata remain readable, and
the unkeyed checksum is not an authenticity or tamper-proofing mechanism.

**Evidence:** `src/broccolidb-wal.ts`, `src/broccolidb-kernel.ts`, and the
restart/replay tests in `test/broccolidb.test.ts`.

### 3. Rename-based base snapshots and named rollback

The kernel writes a versioned base checkpoint envelope that preserves table
application keys, carries a SHA-256 snapshot hash checked during startup, and
uses a temporary file followed by a rename. It writes a separate named history
file and rotates the WAL before adding a checkpoint marker. It keeps named
checkpoint history and restores the records represented
by a selected snapshot through an explicit rollback lifecycle. Legacy value-array
snapshots remain readable, but legacy records without embedded IDs cannot recover
their original table key. The base-file replacement uses a rename operation; its
atomicity and crash behavior depend on the underlying filesystem. History
writing, WAL rotation, and marker append are not one cross-file transaction.
Rollback writes replayable reset frames before its marker, but does not
automatically remove tables created after the selected checkpoint.

**Evidence:** `src/broccolidb-kernel.ts`, `docs/ARCHITECTURE.md`,
`docs/OPERATIONS.md`, and `test/broccolidb.test.ts`.

### 4. Content-addressable blob storage with integrity quarantine

`BroccoliCASStorageService` addresses payloads by SHA-256 digest, conditionally
uses Brotli compression, verifies raw content on the `read()` path, quarantines
decompression or hash failures, records quarantine metadata, and performs a
single sweep over blob files absent from a caller-supplied reference set.
`exists()` checks for a regular file and does not perform content verification.
Hash-shaped identifiers are validated before path construction. Statistics
best-effort decode the on-disk raw/Brotli format under a bounded 64 MiB stats
budget to report raw-byte accounting; `compressionSavingsPct` remains a storage
metric, not a performance benchmark.

**Evidence:** `src/broccolidb-cas.ts`, `docs/OPERATIONS.md`, and the damaged-blob
quarantine test in `test/broccolidb.test.ts`.

### 5. Process-local re-entrant async coordination

`ReentrantAsyncMutex` propagates an async ownership context, supports nested
acquisition by the owner, queues competing work, and rejects waiters that exceed
the configured timeout with explicit lock error types. The timeout is a
contention diagnostic, not proof of a deadlock.

**Evidence:** `src/broccolidb-mutex.ts` and `src/broccolidb-kernel.ts`. The
current test suite exercises the kernel transaction path indirectly; a dedicated
mutex contention test is still a release-hardening item.

### 6. Deterministic offline query and prompt transformation helpers

The natural-query parser translates a constrained human-readable expression
into typed query options without a network or model call. The token compressor
normalizes prompt whitespace and selected structured message content while
preserving provider-shaped metadata.

**Evidence:** `src/broccolidb-natural-query.ts`, `src/TokenCompressionService.ts`,
and `test/token-compression.test.ts`.

## Explicit non-claims and implementation limits

- Only a missing base checkpoint is treated as fresh state. Read, JSON-parse,
  record-shape, or current-envelope hash failure raises
  `CheckpointIntegrityError`; preserve the state directory before retrying or
  restoring.
- The health report exposes current counters and status fields but does not run a
  full WAL replay, CAS content scrub, or independent index-parity scan.
- The package does not encrypt files, coordinate multiple writer processes, or
  provide a benchmark-backed latency/throughput guarantee.

## Evidence and publication checklist

Before relying on this document as a public disclosure record, the steward
should preserve:

- the exact Git commit and remote URL;
- an immutable release tag or archive containing the source, `LICENSE`, and
  `NOTICE`;
- the SHA-256 digest of the source archive and npm tarball;
- the test/build command and host/runtime used for any reported measurement;
- an amendment if the technical description is corrected later.

The current repository baseline is a local Git fact. The public-availability
date must be filled from a verified remote or release record rather than
assumed from a file timestamp or an unpushed commit.
