# Contributing

BroccoliDB is intentionally small and portable. Contributions should preserve
that boundary and make behavior easier to inspect, test, and transfer.

## License, provenance, and IP rules

The current release line is Apache-2.0. The repository uses the Developer
Certificate of Origin 1.1 (`../DCO`): every commit submitted for inclusion must
carry a `Signed-off-by: Name <email>` line. DCO sign-off confirms contribution
provenance and permission to submit under Apache-2.0; it does not assign
copyright or authorize confidential material. The pull-request workflow checks
the complete proposed commit range for the sign-off; a passing local build does
not bypass that provenance gate.

Contributors must:

1. Submit only original work or material they are authorized to contribute.
2. Identify third-party code, generated assets, and their license before adding
   them; do not assume a package’s npm metadata is sufficient evidence.
3. Avoid confidential information, customer data, trade secrets, and patent-
   sensitive disclosures that the contributor is not authorized to publish.
4. Preserve existing SPDX, copyright, license, attribution, and NOTICE
   information. Mark discussion that is not intended for inclusion as `Not a
   Contribution`.
5. Update the IP record only with verifiable source, test, release, or public
   archive evidence. Do not describe repository notes as guaranteed patent
   validity, patent invalidity, or freedom to operate.

Contributions are accepted under Apache-2.0 as described by Section 5 of the
license. A separate written agreement is required before anyone promises
copyright assignment, exclusive rights, or a future commercial relicensing
right.

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
npm run license:check
npm run ip:check
npm run package:check
npm pack --dry-run
```

Run the smallest relevant test while iterating, then run `npm run check` before
handoff. Tests should use temporary workspace roots and always clean them in a
`finally` block.

## Parallel implementation and independent review

The repository's [agent guide](../AGENTS.md) defines how to split work across
coding agents and automation. Give each contributor one outcome, a bounded set
of files, and an acceptance checklist. Assign separate worktrees or non-
overlapping file ownership when multiple people need to edit; a shared working
tree has one writer at a time.

For review work, prefer a read-only assignment with a concrete area such as WAL
recovery, JSONSQL semantics, public API navigation, or release metadata. Ask the
reviewer to return prioritized findings with file/line, a reproduction or source
evidence, impact, and a suggested correction. Keep one integrator responsible
for reconciling findings across code, tests, docs, generated output, and the
final verification pass.

Delegation template:

```text
Outcome:
Scope and file ownership:
Allowed actions:
Must-preserve contracts:
Acceptance criteria:
Validation command:
Report: findings, evidence, risks, unresolved questions
```

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
6. Keep native drivers and full dialect compatibility out of the core. The
   bounded JSONSQL surface is defined by [ADR-005](adr/ADR-005-jsonsql-subset.md);
   grammar or durability expansions require tests and an updated decision.

## Documentation rules

Update the relevant layer whenever behavior changes:

| Change | Required documentation |
|---|---|
| Export or signature | [API reference](API.md) and release notes |
| Lifecycle, durability, or file format | [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md), and an ADR |
| Error or recovery behavior | [Troubleshooting](TROUBLESHOOTING.md) and operations guide |
| Terminology | [Glossary](GLOSSARY.md) and affected docs |
| Supported package/version policy | `README.md` and [release notes](RELEASE_NOTES.md) |
| Vulnerability reporting | [`SECURITY.md`](../SECURITY.md) |

Examples must import from `@noorm/broccolidb` and show lifecycle ownership.
Avoid claims such as “transactional” or “durable” without naming the exact
boundary (`flush`, `transaction`, `compact`, `checkpoint`, or `stop`).

## Pull request checklist

- [ ] The public export surface is intentional.
- [ ] Runtime dependencies remain portable and native-free.
- [ ] TypeScript build passes.
- [ ] Relevant tests pass, including restart/recovery tests where applicable.
- [ ] `npm run docs:check` passes.
- [ ] `npm run license:check` and `npm run ip:check` pass.
- [ ] `npm run package:check` verifies the publish boundary.
- [ ] README/API/operations/ADR/release notes are updated as required.
- [ ] Every submitted commit has a DCO sign-off and any third-party material
      has a recorded license/provenance review.
- [ ] `npm run license:check` passes and source headers use the project SPDX
      identifier.
- [ ] No generated `dist/` or `.broccolidb/` runtime state was added accidentally.
- [ ] `npm pack --dry-run` contains the intended docs and runtime files.

## Release checklist

1. Update `version` in `package.json` and the lockfile.
2. Add a release-note entry describing API and persistence compatibility.
3. Run `npm run check`, `npm audit --omit=dev --audit-level=high`, and `npm pack --dry-run`.
4. Inspect the tarball file list for `dist`, `README.md`, `docs`, `LICENSE`,
   `NOTICE`, and the IP/trademark policies.
5. Confirm the version’s license boundary in `docs/RELEASE_NOTES.md` and the
   package metadata before publishing.
6. Verify a clean consumer can import the compiled package without dev tools.
7. Preserve the immutable artifact, public-accessibility evidence, archive
   digest, and raw audit output before making an external IP or patent claim.
