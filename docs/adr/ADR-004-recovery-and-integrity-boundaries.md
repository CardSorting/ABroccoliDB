# ADR-004: Fail-closed recovery and integrity boundaries

- **Status:** Accepted
- **Date:** 2026-09-21
- **Owners:** BroccoliDB maintainers
- **Scope:** WAL replay, checkpoint startup, rollback durability, and CAS path handling

## Context

The third adversarial audit found recovery paths that could look successful while
silently weakening state integrity:

- restoring a table through its normal mutation hook could append the restored
  records back into the WAL during startup;
- `CLEAR` frames were written but not applied during replay;
- an in-memory rollback marker did not itself reconstruct the rollback after a
  later restart;
- the base-checkpoint loader treated every read or parse failure as an empty
  database; and
- CAS methods constructed filesystem paths from caller-provided hash strings.
- the current base checkpoint had no content-hash verification; and
- rollback interpolated an unvalidated checkpoint ID into a history path.

The WAL also carried previous-frame metadata without independently checking the
declared link, allowing a recomputed frame to describe a discontinuous chain.

## Decision

1. Suppress table WAL hooks while loading a base checkpoint and replaying WAL
   frames. Recovery reads state; it does not generate new mutation frames.
2. Apply `CLEAR` frames during replay. A successful rollback writes replayable
   `CLEAR` and `INSERT` frames before its rollback marker.
3. Store checkpoint base/history tables in a versioned envelope containing each
   application key, record value, and base snapshot hash. Verify the current
   base hash before loading it, while retaining a read path for the legacy
   value-array representation.
4. Treat only a missing base checkpoint as fresh state. Read, JSON-parse, and
   record-shape or snapshot-hash failures raise `CheckpointIntegrityError`.
5. Validate on-disk rollback history shape and its recorded snapshot hash before
   mutating live tables, and reject checkpoint IDs that are not path-safe before
   constructing history paths.
6. During WAL replay, validate frame identity, operation, sequence, checksum,
   and a declared `previousFrameHash` when present. Continue to read legacy
   frames that omit that optional field.
7. Normalize CAS identifiers only after they match a 64-character hexadecimal
   SHA-256 shape. Reject path-like identifiers before filesystem access; sweep
   only valid regular blob files; and do not trust an existing object without a
   content verification pass.
8. Keep these controls in source, tests, public docs, and the evidence-bounded
   claim register. Do not describe them as encryption, authentication, backup,
   cross-process fencing, or a distributed transaction.

## Consequences

### Positive

- Startup is fail-closed for damaged checkpoints instead of silently erasing the
  apparent state.
- Current versioned base checkpoints detect valid-JSON tampering through their
  snapshot hash before loading records.
- On-disk rollback cannot apply a history file whose content no longer matches
  its recorded snapshot hash.
- Restart replay is idempotent with respect to the WAL file and preserves clear
  and rollback semantics.
- Recomputed-but-discontinuous WAL links are classified as integrity failures.
- Untrusted CAS identifiers cannot escape the intended shard path, and temporary
  files are outside the garbage-collection sweep.
- The public claims now point to executable regression tests and named error
  boundaries.

### Trade-offs

- A damaged checkpoint now requires operator recovery instead of automatically
  opening as an empty database.
- Legacy WAL frames without link metadata remain compatible but do not gain a
  retroactive link guarantee.
- CAS `store()` reads and verifies an existing object before reusing its
  address, trading a write-path read for integrity even when a file changed
  outside the current process.
- CAS statistics use a bounded Brotli output budget, so large or damaged
  compressed objects fall back to conservative stored-byte accounting.
- Rollback writes additional replayable frames and still does not remove tables
  created after the selected checkpoint.

## Compatibility impact

The table contract adds `getAllEntries()` for keyed snapshot/export use, while
existing methods and JSONL frame shapes remain unchanged. The checkpoint
base/history payload is now versioned to preserve application keys; current
base files include a checked snapshot hash, and loaders retain a legacy
value-array path. The behavior of malformed input is intentionally stricter.
Existing valid frames, including legacy frames without `previousFrameHash`,
remain readable.

## Alternatives considered

### Continue treating checkpoint errors as a fresh database

Rejected because it can convert recoverable evidence into silent apparent data
loss.

### Add a new WAL format version for link validation

Rejected for this hardening pass. The current frame fields are sufficient, and
legacy omission can be explicitly tolerated while new frames continue emitting
the metadata.

### Use a broad path containment check instead of hash validation

Rejected because the CAS contract is content-addressed; accepting arbitrary
path-shaped names would preserve an unnecessary filesystem attack surface.

## Follow-up hardening — 2026-09-25

A later failure-mode audit found that table writes can continue while checkpoint
files are being persisted. Rotating the entire WAL after a snapshot could erase
frames appended after that snapshot. It also found that atomic rename alone did
not sync checkpoint file contents or parent directory entries before reporting
success.

Checkpointing now captures the WAL frame ID represented by the table snapshot
and rotates only through that boundary. New frame assignment waits during the
short atomic rotation step; newer writes remain in the WAL and are replayed
after the snapshot. Base/history replacement writes and CAS writes sync the
temporary file before rename and sync the containing directory where supported.
The WAL directory is created durably, and creation/rotation syncs its directory
entry where supported.

WAL replay also repairs an invalid unterminated final tail after validating its
complete prefix, repairs the terminator of a valid final frame, and reports
those actions in `health().pillars.walJournal`. Complete-frame checksum, link,
sequence, or shape failures remain fatal.

These are still filesystem-level operations rather than one cross-file
transaction. Multi-file backups must stop or quiesce the application, and
independent processes still require an external single-writer protocol.
