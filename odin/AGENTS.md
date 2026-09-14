# AGENTS — Non-Negotiable Discipline

## Core statement

We start from the Orca source of truth.  
We keep everything that already works.  
We surgically replace only the residual failure modes listed in DIRECTION.md with stricter, simpler contracts.  
We prove the new contracts by making the exact bugs Orca still has stop reproducing.  
Everything else is out of scope.

## Hard rules (never violate)

1. The live Orca repository (this clone) is the single source of truth. Cite the exact file, issue, or PR for every claim of a residual failure.
2. Never invent, never assume, never rely on memory.
3. Prefer deletion and simplification over new abstraction.
4. No scope creep. No “nice-to-have.” No parallel implementations of anything Orca already solved.
5. Safety and security are contracts, not features:
   - no silent hooks
   - no credential duplication
   - no default permission bypass
   - localhost-only daemons
   - positive evidence only
6. Clients never write authoritative execution state.
7. Silence or loss of contact → `unverifiable` (never `accepted` or `exited`).
8. `exited` may be written only with positive process-owner provenance.
9. One wire send per idempotency key.
10. Consent is denied by default and fail-closed.

## Verification requirement

Before and after any change that touches status, settlement, agent identity, process ownership, inventory, or consent:

- Reproduce the relevant Orca residual failure under the same conditions.
- Show that it no longer occurs.
- Keep the proof minimal, deterministic, and checked in.

## Reporting standard

When you finish an increment, report only:

- What residual failure was closed (with Orca citation)
- What code changed
- The exact proof that the failure no longer reproduces
- Whether the definition-of-done items for that increment are met

Do not claim “done” for Odin until every item in DIRECTION.md Definition of done is true.