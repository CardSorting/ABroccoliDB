# Agent and automation guidance

Use this guide for coding agents, delegated reviewers, and automation working in
the BroccoliDB repository. The implementation and tests define current
behavior; update public docs when a contract changes.

## Project boundaries

- Keep the package ESM-only and compatible with Node.js 18 or newer.
- Keep production dependencies at zero unless an ADR justifies an exception.
- Treat JSONSQL as a bounded embedded subset, not a SQLite or PostgreSQL server.
- Name durability boundaries precisely: in-memory mutation, `flush()`,
  `checkpoint()`, and `stop()` do not mean the same thing.
- Treat WAL, checkpoints, CAS, SQL catalog, exports, and serialized types as
  compatibility-sensitive surfaces.
- Do not edit generated `dist/` files directly. Regenerate them with the build.

## Source map

| Concern | Source of truth |
|---|---|
| Public exports and contracts | `src/index.ts`, `src/broccolidb.contracts.ts` |
| Kernel lifecycle and recovery | `src/broccolidb-kernel.ts` |
| Tables, indexes, and TTL | `src/broccolidb-table.ts` |
| JSONSQL grammar and execution | `src/broccolidb-jsonsql.ts` |
| WAL and checksums | `src/broccolidb-wal.ts` |
| Locking | `src/broccolidb-mutex.ts` |
| Behavior evidence | `test/` |
| Contributor process | `docs/CONTRIBUTING.md` |

## Delegation and parallel work

Give every work item a single owner and a small acceptance checklist. Prefer
read-only review tasks for parallel agents. If two contributors must edit code,
assign non-overlapping files or give them separate worktrees; never have
multiple writers modify the same shared working tree at once. One integrator
owns cross-file decisions, conflict resolution, generated output, and the final
verification pass.

Each delegated task should state:

1. the exact outcome and files or subsystem in scope;
2. whether edits and commands are allowed;
3. constraints that must remain true;
4. acceptance criteria and the smallest relevant validation command;
5. the report format: findings with file/line, evidence, risks, and unresolved
   questions.

Reviewers should return prioritized, reproducible findings and avoid editing the
same implementation they are reviewing. The integrator decides which findings
to fix, records deferred issues, and checks that source, tests, API/operations
docs, ADRs, and generated declarations agree.

## Verification

The contributor guide documents focused iteration and the release gate. Use
`npm run check` for an integration handoff after the implementation and docs
are ready; it runs documentation, IP, test, license, and package checks.
