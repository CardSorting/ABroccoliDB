<!-- docs-scope: decision-record -->

# ADR-006: WAL compaction without named checkpoint history

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** BroccoliDB maintainers
- **Scope:** base snapshot compaction and WAL rotation

## Context

Applications that frequently delete large terminal records can leave old
payloads in the append-only WAL after table pruning. A named `checkpoint()` can
rotate the WAL, but it also keeps a full timeline history file for rollback.
Some hosts need to reclaim old frames without retaining that duplicate history.

## Decision

Expose `db.compact()` as a history-free snapshot operation. It flushes WAL
frames, writes the existing versioned and hashed base snapshot atomically,
rotates only through the captured WAL boundary, and appends a compact marker
after a successful rotation. It does not add an entry to `listCheckpoints()` or
write a file under `checkpoints/`.

If newer WAL frames cross the snapshot boundary before rotation, return
`false` and keep the WAL intact. The new base and retained WAL remain recoverable
because the snapshot represents an earlier prefix and replay is idempotent for
the supported row mutations. A later compaction can retry. Named checkpoints
and rollback continue to use `checkpoint()` and its retained history.

## Alternatives

- Use `checkpoint()` for every maintenance pass. Rejected because each call
  keeps a named full-table history file even when rollback is not needed.
- Truncate the WAL directly from the application. Rejected because the host
  must coordinate frame boundaries, base snapshot integrity, and rotation.
- Leave the WAL append-only. Rejected for hosts that delete large values and
  need a bounded on-disk history.

## Consequences

Compaction preserves the existing base-checkpoint format and adds no runtime
dependency. It is not a backup, named restore point, cross-process lock or
transaction. Hosts still need to preserve the complete `.broccolidb/` directory
and use `checkpoint()` when timeline rollback is required.

## Confirmation

`test/broccolidb.test.ts` covers successful rotation, the absence of named
history, and restart recovery of records on both sides of the compaction
boundary. API and operator contracts are in [API](../API.md) and
[Operations](../OPERATIONS.md).
