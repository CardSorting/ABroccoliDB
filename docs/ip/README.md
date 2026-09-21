# BroccoliDB IP and provenance record

This directory is an evidence-oriented engineering record inspired by the
LUMI-NEW prior-art structure. It is not a patent application, an invention-
assignment agreement, a freedom-to-operate opinion, or legal advice.

## Documents

- [Invention disclosure and prior-art record](INVENTION-DISCLOSURE-AND-PRIOR-ART.md)
  — technical mechanisms, source evidence, and date discipline.
- [Defensive prior-art index](DEFENSIVE-PRIOR-ART-CLAIMS.md) — structured
  search terms and element-level descriptions without claiming patent validity.
- [Claim register](CLAIM-REGISTER.md) — bounded engineering statements with
  evidence paths, limitations, and review status.
- [Repository licensing strategy](../LEGAL-STRATEGY.md) — license boundaries,
  threat model, contribution controls, and release procedure.

## Evidence rules

1. Describe behavior that can be checked in source, tests, generated artifacts,
   or an identified release; do not convert marketing claims into legal claims.
2. Record the exact commit, release artifact, environment, and command for
   performance measurements. A benchmark number is not a permanent guarantee.
3. Treat a commit date as a repository timestamp only. Use a date as a public
   prior-art date only after verifying that the corresponding commit, release,
   or archive was actually publicly available and preserved.
4. Do not call this record “irrefutable,” “legally binding prior art,” or proof
   that a patent is invalid. The legal effect of a disclosure is jurisdiction-
   and fact-dependent.
5. Preserve history and release artifacts rather than rewriting them to improve
   a later narrative. Correct factual errors with a dated amendment.

For U.S. patent analysis, public accessibility and evidence of the posting date
are separate questions from a local commit timestamp. The USPTO's MPEP § 2128
describes public accessibility as the touchstone for internet publications and
warns that an unproven posting date may prevent reliance on the document as
prior art. Apply that rule through counsel to the relevant jurisdiction and
critical date; do not infer a legal effect from this repository's timestamps.
