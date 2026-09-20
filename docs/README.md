# BroccoliDB documentation

This is the documentation map for the standalone `@noorm/broccolidb` package.
The package docs follow a layered structure used by mature storage systems:

**Concepts → How it works → Reference → Operations → Decisions**

The implementation and tests are authoritative when documentation disagrees.
This map explains where a claim belongs and gives each reader a shortest useful
path through the package.

## Reading paths by role

| Role | Start here | Then read |
|---|---|---|
| **Application developer** | [Quick start](../README.md#quick-start) | [API reference](API.md) · [Operations](OPERATIONS.md) |
| **Architect / reviewer** | [Brief](BRIEF.md) | [Architecture](ARCHITECTURE.md) · [Philosophy](PHILOSOPHY.md) · [ADR-001](adr/ADR-001-portable-inmemory-kernel.md) |
| **Operator / support** | [Operations](OPERATIONS.md) | [Troubleshooting](TROUBLESHOOTING.md) · [Glossary](GLOSSARY.md) |
| **Contributor** | [Contributing](CONTRIBUTING.md) | [Architecture](ARCHITECTURE.md) · [API reference](API.md) · [ADR process](adr/README.md) |
| **Auditor / security reviewer** | [Boundaries](PHILOSOPHY.md#boundaries) | [Operations](OPERATIONS.md#integrity-and-recovery) · [Architecture](ARCHITECTURE.md#failure-model) |
| **Release owner** | [Release notes](RELEASE_NOTES.md) | [Contributing](CONTRIBUTING.md#release-checklist) · [ADR index](adr/README.md) |

## Document catalog

### Concepts — why

| Document | Purpose |
|---|---|
| [Brief](BRIEF.md) | One-page problem statement, solution, guarantees, and non-goals |
| [Philosophy](PHILOSOPHY.md) | Design principles, explicit trade-offs, and rejected alternatives |
| [Glossary](GLOSSARY.md) | Canonical terms for tables, WAL, CAS, checkpoints, and recovery |

### How it works — what happens

| Document | Purpose |
|---|---|
| [Architecture](ARCHITECTURE.md) | Runtime layers, mutation flow, startup, checkpointing, rollback, and failure model |
| [Operations](OPERATIONS.md) | Filesystem layout, lifecycle rules, backup/restore, integrity, and garbage collection |

### Reference — what to call

| Document | Purpose |
|---|---|
| [API reference](API.md) | Public exports, kernel/table methods, query operators, indexes, aggregation, and events |
| [Package README](../README.md) | Install, minimal example, portability statement, and command index |
| [Source entry point](../src/index.ts) | Export surface — the source of truth for package imports |
| [Contracts](../src/broccolidb.contracts.ts) | Type-level API and serialized record contracts |

### Operations — how to run and debug

| Document | Purpose |
|---|---|
| [Operations guide](OPERATIONS.md) | Start/stop, durability boundaries, backup, recovery, health, and CAS GC |
| [Troubleshooting](TROUBLESHOOTING.md) | Symptom → likely cause → action runbooks |
| [Release notes](RELEASE_NOTES.md) | Supported release history and compatibility policy |

### Decisions — why the shape is stable

| Document | Purpose |
|---|---|
| [ADR index](adr/README.md) | Decision inventory and writing rules |
| [ADR-001](adr/ADR-001-portable-inmemory-kernel.md) | Why BroccoliDB is a portable in-memory kernel with explicit file durability |

## Documentation conventions

1. **Describe the current package.** Do not document the removed in-repository
   SQLite implementation or imply that it remains supported.
2. **Use contract language.** Distinguish what is guaranteed after an in-memory
   mutation, after `flush()`, after `checkpoint()`, and after `stop()`.
3. **Name the source of truth.** Public exports live in `src/index.ts`; type
   contracts live in `src/broccolidb.contracts.ts`; behavior is verified by
   `test/`.
4. **Keep examples executable.** Examples should use the public package import,
   explicit lifecycle calls, and a temporary or application-owned workspace.
5. **Document failure boundaries.** Say what is process-local, what is on disk,
   what is recoverable, and what requires an external coordination system.
6. **Prefer stable vocabulary.** Say table, record, WAL frame, checkpoint, CAS
   blob, replay, rollback, flush, and health report consistently.
7. **Update docs with contracts.** Export changes, file-format changes, and
   durability changes require API/operations updates plus an ADR or release note.

## Source-of-truth matrix

| Question | Source of truth |
|---|---|
| What can consumers import? | `src/index.ts` and generated `dist/index.d.ts` |
| What does a method accept/return? | `src/broccolidb.contracts.ts` and class signatures |
| How does a write reach disk? | `src/broccolidb-kernel.ts` and `src/broccolidb-wal.ts` |
| How are blobs addressed and verified? | `src/broccolidb-cas.ts` |
| What behavior is protected? | `test/*.test.ts` |
| Is the package publishable? | `package.json`, `npm pack --dry-run`, and `npm run docs:check` |

## Status

| Metric | Current value |
|---|---|
| Package | `@noorm/broccolidb@2.0.1` |
| API status | Standalone supported package; modern ESM surface |
| Runtime dependencies | 0 |
| Node.js | `>=18` |
| Public entry point | `src/index.ts` / `dist/index.js` |
| Persistence | In-memory tables + optional filesystem WAL/checkpoints/CAS |
| License | MIT |

## Quick links

```bash
# Build and test the implementation
npm test

# Validate docs and relative Markdown links
npm run docs:check

# Inspect the publishable artifact without creating it
npm pack --dry-run
```
