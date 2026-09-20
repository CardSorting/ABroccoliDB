# Contributing

BroccoliDB is intentionally small and portable. Contributions should preserve
that boundary and make behavior easier to inspect, test, and transfer.

## Source map

| Area | Location |
|---|---|
| Public exports | `src/index.ts` |
| Public contracts | `src/broccolidb.contracts.ts` |
| Kernel lifecycle | `src/broccolidb-kernel.ts` |
| Tables and indexes | `src/broccolidb-table.ts` |
| WAL | `src/broccolidb-wal.ts` |
| CAS | `src/broccolidb-cas.ts` |
| Queries and aggregation | `src/broccolidb-natural-query.ts`, `src/broccolidb-aggregation.ts` |
| Locking | `src/broccolidb-mutex.ts` |
| Prompt compression | `src/TokenCompressionService.ts` |
| Tests | `test/` |
| Documentation | `README.md`, `docs/`, `docs/adr/` |

## Development workflow

```bash
npm install
npm run build
npm test
npm run docs:check
npm pack --dry-run
```

Run the smallest relevant test while iterating, then run `npm run check` before
handoff. Tests should use temporary workspace roots and always clean them in a
`finally` block.

## Contract rules

1. Keep the runtime dependency list empty unless a dependency is unavoidable,
   justified in an ADR, and compatible with Node.js `>=18`.
2. Preserve ESM-compatible relative imports and the public package export.
3. Treat WAL, checkpoint, CAS, and serialized contract changes as compatibility
   changes even when TypeScript still compiles.
4. Add tests for startup/replay, checkpoint/rollback, integrity failures, and
   query/index behavior when changing those areas.
5. Keep `transaction()` callbacks deterministic and avoid network or long-lived
   external work while holding the kernel mutex.
6. Do not introduce an SQL or native-driver compatibility layer into the core.

## Documentation rules

Update the relevant layer whenever behavior changes:

| Change | Required documentation |
|---|---|
| Export or signature | [API reference](API.md) and release notes |
| Lifecycle, durability, or file format | [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md), and an ADR |
| Error or recovery behavior | [Troubleshooting](TROUBLESHOOTING.md) and operations guide |
| Terminology | [Glossary](GLOSSARY.md) and affected docs |
| Supported package/version policy | `README.md` and [release notes](RELEASE_NOTES.md) |

Examples must import from `@noorm/broccolidb` and show lifecycle ownership.
Avoid claims such as “transactional” or “durable” without naming the exact
boundary (`flush`, `transaction`, `checkpoint`, or `stop`).

## Pull request checklist

- [ ] The public export surface is intentional.
- [ ] Runtime dependencies remain portable and native-free.
- [ ] TypeScript build passes.
- [ ] Relevant tests pass, including restart/recovery tests where applicable.
- [ ] `npm run docs:check` passes.
- [ ] README/API/operations/ADR/release notes are updated as required.
- [ ] No generated `dist/` or `.broccolidb/` runtime state was added accidentally.
- [ ] `npm pack --dry-run` contains the intended docs and runtime files.

## Release checklist

1. Update `version` in `package.json` and the lockfile.
2. Add a release-note entry describing API and persistence compatibility.
3. Run `npm run check` and `npm pack --dry-run`.
4. Inspect the tarball file list for `dist`, `README.md`, `docs`, and `LICENSE`.
5. Verify a clean consumer can import the compiled package without dev tools.
