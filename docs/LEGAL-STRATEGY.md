# BroccoliDB licensing and IP strategy

This document records the repository’s defensive licensing posture. It is an
engineering and release-control document, not legal advice, a patent opinion,
or a substitute for an attorney reviewing ownership, employment agreements,
trademark clearance, or patent strategy.

## Current position

| Release line | License | What changed |
|---|---|---|
| `2.0.x` | MIT | Historical package line; permissions already granted are not revoked |
| `3.0.0+` | Apache-2.0 | Express contributor patent grant/termination, NOTICE, no trademark grant, provenance controls |

The source of truth for the operative grant is [`LICENSE`](../LICENSE). The
`NOTICE`, [defensive policy](../PATENT-NON-AGGRESSION-PLEDGE.md), and
[trademark policy](../TRADEMARKS.md) supplement the distribution and explain
how the project preserves evidence; they do not secretly add restrictions to
Apache-2.0.

## Creator-control decision boundary

| Desired control | Instrument that would actually be needed | Current release position |
|---|---|---|
| Stop unpaid commercial use | A separately reviewed source-available or commercial license | Not available in `3.0.0+`; Apache permits commercial use |
| Retain exclusive future relicensing power | Complete chain of title plus a prospective CLA or assignment from every relevant contributor | DCO-only; no automatic relicensing power |
| Control forks and hosted-service branding | Trademark clearance, actual use, and a maintained naming policy | Naming policy exists; registration and enforcement are not claimed |
| Preserve a defensive publication | Publicly accessible immutable artifact with verified contents and date | Evidence packet is specified; public availability is not assumed |

This boundary is intentional. A README, `NOTICE`, patent pledge, or DCO cannot
silently add restrictions to an Apache-licensed work or create rights that the
steward does not hold.

## Threat model and control map

| Threat | Control in this repository | Remaining limit |
|---|---|---|
| A distributor removes attribution or silently changes files | Apache Sections 4(b)–(d), source headers, `NOTICE`, package inclusion checks | Enforcement still requires evidence and a jurisdiction-specific response |
| A recipient brings patent litigation while relying on the grant | Apache Section 3 defensive termination | It covers the Apache patent grant for the Work; it is not a warranty against third-party patents |
| A fork creates brand confusion | Apache Section 6 and `TRADEMARKS.md` | Trademark rights, registration, and enforcement depend on actual use and applicable law |
| A contributor submits code they do not own | DCO sign-off, contribution checklist, provenance review | DCO is a certification, not a complete chain-of-title investigation or copyright assignment |
| Public claims overstate novelty or prior-art effect | Evidence-only IP record and disclosure language | A public repository does not guarantee patent invalidity or a date recognized everywhere |
| A local commit is mistaken for a legally effective public disclosure | Claim register, immutable artifact checklist, and public-accessibility date review | Public availability, critical dates, and legal effect remain jurisdiction- and fact-dependent |
| License metadata drifts between source and npm artifact | SPDX headers, package metadata, `NOTICE`, `license:check`, release checklist | CI/GitHub branch protection must be enabled by the repository owner |
| A commercial party uses the library without paying the creator | Apache-2.0 expressly permits commercial use | This release line cannot prohibit that use; use a separate counsel-reviewed commercial/source-available strategy if exclusivity is required |

## Enforcement posture

The project’s defensible enforcement targets are preservation of copyright and
license notices, compliance with Apache redistribution conditions, misleading
use of the project’s marks, and patent-litigation retaliation under Apache
Section 3. The project should preserve the exact artifact, source commit,
package metadata, NOTICE, and checksums before making a demand or public
statement.

The project must not claim that a repository note is “irrefutable prior art,”
that a patent is invalid, or that use is free of third-party claims. Those are
legal conclusions. The IP record instead names technical elements, evidence
paths, and the dates that still need public-availability verification.

## Contribution and relicensing boundary

The DCO protects provenance by requiring a contributor to certify that they
have the right to submit the work under the indicated open-source license. It
does not transfer the contributor’s copyright to the project steward and does
not automatically authorize a future proprietary relicensing program.

The DCO is prospective repository policy. It does not retroactively sign the
historical `2.0.x` commits or prove that every historical line, generated file,
idea, or dependency was owned by the current steward. Before asserting exclusive
rights, the steward should audit employment/contractor obligations, third-party
imports, generated artifacts, and every contributor or obtain the appropriate
written agreements.

If the project later needs a commercial dual-license offering, the steward
should first establish a complete chain of title, decide whether a CLA or
copyright assignment is appropriate, obtain explicit agreements from existing
contributors, and publish a new license decision. Do not infer those rights
from a DCO sign-off or from Apache Section 5.

## Release controls

Before publishing a new version:

1. Confirm the version boundary and license in `package.json`, the lockfile,
   README, release notes, and the package dry-run.
2. Run `npm run check`, including `npm run license:check` and
   `npm run ip:check`.
3. Run `npm run package:check`, then inspect the tarball for `LICENSE`, `NOTICE`,
   `README.md`, `docs`, the IP policy, and the trademark policy.
4. Confirm every proposed commit has a DCO sign-off. Preserve the immutable
   Git commit, package tarball digest, and release archive. Do not rewrite a
   published release to change its legal record.
5. Record any third-party source, generated asset, or dependency license in
   the release review before shipping it.

For U.S. patent work, the release packet should separately preserve evidence of
public accessibility and the posting date. USPTO MPEP § 2128 treats public
accessibility as central to internet-publication analysis and notes that an
unproven posting date can limit reliance on a document as prior art. This is a
review trigger, not a conclusion that any BroccoliDB commit qualifies as prior
art.

## Sources and standards

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [Applying Apache License 2.0](https://www.apache.org/legal/apply-license)
- [SPDX license identifiers](https://spdx.dev/ids/)
- [Developer Certificate of Origin 1.1](https://developercertificate.org/)
- [REUSE specification](https://reuse.software/spec-3.0/)
- [USPTO MPEP § 2128 — “Printed Publications” as Prior Art](https://www.uspto.gov/web/offices/pac/mpep/s2128.html)
