# DIRECTION — Finish Odin End-to-End

## Exact goal

We start from the Orca source of truth (this repository is a clone of https://github.com/stablyai/orca).  
We keep everything that already works.  
We surgically replace only the residual failure modes listed below with stricter, simpler contracts.  
We prove the new contracts by making the exact bugs Orca still has stop reproducing.  
Everything else is out of scope.

The end state is a complete, usable Odin that teams can run safely and securely because the known residual failure modes have been closed.

## Residual failure modes that must be closed (only these)

1. **Orchestration still relies on terminal scraping and heuristics**
   - Three-valued settlement only: `accepted | refused{reason} | unverifiable{reason}`
   - Durable Runs / Tasks / Dispatches / Mailboxes that survive crash and reconnect
   - Explicit nesting depth policy (no accidental fences)
   - No inference of success from keystrokes or screen scraping

2. **Agent status is still multi-copy and reader-side adjudicated**
   - Execution host owns one status store
   - Every producer writes into it once
   - Every reader only subscribes
   - No second copies, no reader-side precedence

3. **No trusted host capability inventory**
   - First-class live inventory of installed agents × models × effort
   - Applied launch options are returned to the caller
   - Coordinators never guess or parse banners

4. **Process lifecycle and ownership are incomplete**
   - Exact process-tree ownership on macOS / Windows / Linux
   - Fixed vocabulary only: `live / unverifiable / exited`
   - Loss of contact is never reported as exited
   - Daemon binds localhost by default

5. **Default security posture is permissive and non-consensual**
   - No silent hooks into other tools’ configs
   - No silent credential duplication
   - No default permission-bypass flags
   - Explicit user consent for telemetry, hooks, and network exposure

## Required Agent Graph trust model

- Host-owned single writer
- Capability tokens for scoped authority and nesting limits
- Settlement receipts are the evidence that authorises graph transitions
- Sub-agent identity is first-class and never flattened into the parent terminal

## Build order (atomic increments — finish each before starting the next)

1. Single-writer status store + three-valued settlement
2. Provider-neutral Agent Graph + live inventory
3. Exact process ownership + consent gates
4. Durable recovery with real agent sessions (Claude or Codex end-to-end)
5. Cost/resource accounting on the graph
6. Final integration proof and README side-by-side table

After each increment: reproduce the corresponding Orca residual bugs and show they no longer occur.

## Definition of done (all must be true)

- The exact residual failures documented in Orca’s own issues and reference docs no longer reproduce under the same conditions.
- A real local Claude or Codex session can be driven end-to-end through settlement and the Agent Graph.
- Crash mid-send → recover from journals with no duplicate work and no false `exited`.
- Default launch never bypasses permissions without explicit consent.
- Daemon is localhost-only by default.
- README contains a clear side-by-side table: “Orca residual failure (with link) → our stricter contract”.
- The system is usable as a drop-in safer derivative of Orca.

## Success criteria

Odin is finished when a team can run multi-agent workflows with higher confidence than on stock Orca because the known residual failure modes have been closed with stricter, simpler contracts — not with more heuristics or a parallel product surface.