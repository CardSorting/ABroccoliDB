# Glossary

| Term | Meaning |
|---|---|
| **Table** | An in-memory collection of records keyed by string IDs and optionally backed by WAL frames. |
| **Record** | A JSON-compatible application object stored under a table ID. |
| **Index** | A secondary lookup structure maintained by a table for equality, sorted, composite, or prefix queries. |
| **WAL** | Write-ahead log: append-only JSONL mutation frames used for durability and restart replay. |
| **WAL frame** | One `INSERT`, `UPDATE`, `DELETE`, `CLEAR`, `CHECKPOINT`, `ROLLBACK`, or `BRANCH_MERGE` operation record with checksum metadata. |
| **Flush** | Writing buffered WAL frames to `.broccolidb/wal.log`. |
| **Checkpoint** | A complete JSON table snapshot plus a named history record that permits faster restart and rollback. |
| **Rollback** | Restoring table state from a checkpoint held in memory or loaded from checkpoint history on disk. |
| **CAS** | Content-addressable storage: blobs are named by the SHA-256 hash of their raw content. |
| **Shard** | The two-character directory prefix used to spread CAS blob files across directories. |
| **Quarantine** | Moving a corrupted CAS blob into `.broccolidb/cas/corrupt/` and recording an audit entry. |
| **CDC** | Change-data capture: table subscriptions receive insert, update, delete, clear, and expiration events. |
| **TTL** | Optional time-to-live on a write; expired records emit an `EXPIRE` change event. |
| **Natural query** | An offline parser that turns constrained human-readable text into `DbQueryOptions`; it is not an LLM. |
| **Fluent query** | A chainable `select().where(...).orderBy(...).execute()` builder over one table. |
| **Transaction** | A kernel mutex scope that runs an async callback and flushes the WAL when the callback completes. |
| **Health report** | A diagnostic snapshot covering directory writability, CAS metrics, WAL metrics, and table counts. |
| **Workspace root** | The caller-selected filesystem root below which `.broccolidb/` is created. |
| **Runtime dependency** | A package required by consumers at runtime. BroccoliDB has none; TypeScript, `tsx`, and Node types are development dependencies. |
