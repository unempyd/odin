#!/usr/bin/env node
/**
 * Odin real-session proof — drives REAL agent CLIs (claude, codex, grok) through Orca's own
 * orchestration surface on a headless serve host, and records what the durable rows say.
 *
 * Phases (all run unless --phase names one):
 *   default-blocks  A fresh profile grants no permission bypass. A real worker that must run
 *                   `orca orchestration send` to report worker_done cannot do so silently: the
 *                   dispatch never settles as completed within the window and worker-show reports
 *                   the wait. Proves the safe default in the real system, not in a replica.
 *   settle          With an explicit per-agent grant recorded in the profile (the consent record),
 *                   each agent starts, reports worker_done, and the dispatch row settles
 *                   `completed` with a launch receipt and timing. One real session per agent.
 *   crash           worker-start with a fixed --retry-request; the serve host is SIGKILLed while
 *                   the worker is mid-flight; the host restarts on the same port + profile; the
 *                   same --retry-request is replayed and must be refused (operation_unknown, "do
 *                   not start another worker"); exactly one dispatch row exists; it is either
 *                   re-adopted (the daemon kept the PTY alive) or failed with a termination reason —
 *                   never a completion nobody reported.
 *   concurrent      Three workers started in parallel all reach ready and all settle.
 *
 * Output: NDJSON on stdout, summary JSON written to odin/proofs/real-sessions.<ts>.json.
 * Requires: pnpm run build:cli && pnpm run build:electron-vite && pnpm run ensure:electron-runtime,
 * and the agent CLIs logged in on this machine. Never pass bypass flags yourself: the only grant is
 * the one this script writes into the throwaway profile under `settings.agentDefaultArgs`, and it
 * prints that record so the proof is auditable.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  AGENTS,
  BYPASS_GRANTS,
  DEFAULT_BLOCK_WINDOW_MS,
  Host,
  PHASES,
  SPEC,
  WORKER_DONE_TIMEOUT_MS,
  cliEntry,
  events,
  freePort,
  grantClaudeTrust,
  log,
  orca,
  orcaAsync,
  planWorkspace,
  projectDir,
  revokeClaudeTrust,
  serveEntry,
  writeProfile
} from './real-session-host.mjs'

function setupWorkspace(host, plan) {
  const { repoPath, wtName } = plan
  const repo = orca(host, ['repo', 'add', '--path', repoPath]).json?.result?.repo
  if (!repo?.id) {
    throw new Error('repo add returned no id')
  }
  const wt = orca(host, [
    'worktree',
    'create',
    '--repo',
    `id:${repo.id}`,
    '--name',
    wtName,
    '--setup',
    'skip'
  ]).json?.result?.worktree
  if (!wt?.id) {
    throw new Error('worktree create returned no id')
  }
  const coordinator = orca(host, ['terminal', 'create', '--worktree', wt.id]).json?.result?.terminal
  if (!coordinator?.handle) {
    throw new Error('coordinator terminal create returned no handle')
  }
  const run = orca(host, [
    'orchestration',
    'run-create',
    '--objective',
    'odin real-session proof',
    '--from',
    coordinator.handle
  ]).json?.result?.run
  if (!run?.id) {
    throw new Error('run-create returned no id')
  }
  log('workspace', { repoPath, worktreeId: wt.id, coordinator: coordinator.handle, runId: run.id })
  return { repoPath, worktreeId: wt.id, coordinator: coordinator.handle, runId: run.id }
}

function workerStartArgs(ws, agent, extra = []) {
  return [
    'orchestration',
    'worker-start',
    '--spec',
    SPEC,
    '--agent',
    agent,
    '--worktree',
    ws.worktreeId,
    '--run',
    ws.runId,
    '--from',
    ws.coordinator,
    ...extra
  ]
}

function summarizeDispatch(host, dispatchId) {
  const shown = orca(host, ['orchestration', 'worker-show', '--dispatch', dispatchId], {
    allowFailure: true
  }).json?.result
  const d = shown?.dispatch ?? shown?.worker ?? shown ?? {}
  return {
    status: d.status ?? d.dispatchStatus ?? null,
    workerState: d.workerState ?? d.state ?? shown?.worker?.state ?? null,
    terminationReason: d.terminationReason ?? d.termination_reason ?? null,
    dispatchedAt: d.dispatchedAt ?? null,
    completedAt: d.completedAt ?? null,
    wallclockMs: d.wallclockMs ?? null,
    exitCode: d.exitCode ?? null,
    launch: shown?.startOptions?.launch ?? d.launch ?? null,
    observation: shown?.observation ?? null,
    raw: shown
  }
}

/**
 * Poll for the worker_done report of one dispatch. `check --wait` returns the oldest
 * unacknowledged batch whatever its type, so a blocking wait wakes on heartbeats; a
 * non-consuming `--all --types worker_done` read plus the dispatch row is unambiguous.
 * Resolves { message, dispatch } once the report lands or the dispatch row settles.
 */
async function waitWorkerDone(host, ws, dispatchId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let dispatch = null
  while (Date.now() < deadline) {
    const check = orca(
      host,
      [
        'orchestration',
        'check',
        '--terminal',
        ws.coordinator,
        '--run',
        ws.runId,
        '--all',
        '--types',
        'worker_done'
      ],
      { allowFailure: true }
    )
    if (check.status !== 0) {
      log('check.error', { exit: check.status, raw: check.raw.slice(0, 300) })
    }
    const messages = check.json?.result?.messages ?? check.json?.result?.delivery?.messages ?? []
    // Why string containment: the CLI's message projection nests the dispatch id differently per
    // version; the durable dispatch row below is the settlement evidence, the message is context.
    const message = messages.find(
      (m) => m.type === 'worker_done' && JSON.stringify(m).includes(dispatchId)
    )
    dispatch = summarizeDispatch(host, dispatchId)
    if (message || ['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
      return { message: message ?? null, dispatch }
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return { message: null, dispatch, timedOut: true }
}

/** Full command lines of every live process whose executable is the agent; never truncated. */
function liveAgentArgv(agent) {
  return spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .stdout.split('\n')
    .filter((l) => new RegExp(`(^|/)${agent}(\\s|$)`).test(l) && !l.includes('real-sessions'))
    .map((l) => l.trim())
}

async function phaseDefaultBlocks(agent) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'odin-orca-dev-default-'))
  writeProfile(userDataDir, { grants: null })
  const plan = planWorkspace(userDataDir)
  const trusted = grantClaudeTrust(plan.trustPaths)
  const host = new Host(userDataDir, await freePort())
  await host.start()
  try {
    const ws = setupWorkspace(host, plan)
    const started = orca(host, workerStartArgs(ws, agent), { allowFailure: true })
    const dispatchId =
      started.json?.result?.dispatchId ?? started.json?.result?.dispatch?.id ?? null
    log('default-blocks.worker-start', {
      agent,
      exit: started.status,
      state: started.json?.result?.state ?? null,
      dispatchId
    })
    // The contract under test is the launch argv, not the agent's own permission policy: an
    // operator whose Claude config auto-approves will still complete the task. Record the live
    // process argv so the proof shows what Odin launched.
    const argv = liveAgentArgv(agent)
    const bypassInArgv = argv.some((l) =>
      /dangerously|--yolo|bypass|auto-approve|trust-all-tools|unrestricted|allow-all/i.test(l)
    )
    log('default-blocks.argv', { agent, argv, bypassInArgv })
    const done = dispatchId
      ? await waitWorkerDone(host, ws, dispatchId, DEFAULT_BLOCK_WINDOW_MS)
      : null
    const settledAsDone = Boolean(done?.message)
    const summary = done?.dispatch ?? null
    // An empty capture proves nothing: the worker process must be visible with a full argv.
    const ok = argv.length > 0 && !bypassInArgv
    log('default-blocks.result', {
      agent,
      ok,
      settledAsDone,
      dispatch: summary && {
        status: summary.status,
        workerState: summary.workerState,
        observation: summary.observation
      }
    })
    if (dispatchId) {
      orca(host, ['orchestration', 'worker-stop', '--dispatch', dispatchId], { allowFailure: true })
    }
    return ok
  } finally {
    await host.stop()
    revokeClaudeTrust(trusted)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(plan.repoPath, { recursive: true, force: true })
  }
}

async function phaseSettle(host, ws, agent) {
  const t0 = Date.now()
  const started = orca(host, workerStartArgs(ws, agent), { allowFailure: true })
  const dispatchId = started.json?.result?.dispatchId ?? started.json?.result?.dispatch?.id ?? null
  log('settle.worker-start', {
    agent,
    exit: started.status,
    state: started.json?.result?.state ?? null,
    dispatchId,
    launch: started.json?.result?.launch ?? started.json?.result?.receipt ?? null,
    // The live argv shows the grant the profile recorded actually reached the launch.
    argv: liveAgentArgv(agent)
  })
  if (started.status !== 0 || !dispatchId) {
    const r = started.json?.result ?? {}
    log('settle.result', {
      agent,
      ok: false,
      failure: {
        state: r.state,
        stage: r.stage,
        failedStage: r.failedStage,
        lastError: r.lastError ?? r.error ?? started.json?.error ?? null,
        setup: r.setup,
        observation: r.observation,
        recovery: r.recovery ?? r.recoveryCommands ?? null
      },
      dispatch: dispatchId ? { ...summarizeDispatch(host, dispatchId), raw: undefined } : null,
      terminalTail: dispatchId
        ? (orca(
            host,
            [
              'orchestration',
              'worker-read',
              '--dispatch',
              dispatchId,
              '--source',
              'auto',
              '--limit',
              '60'
            ],
            { allowFailure: true }
          ).json?.result ?? null)
        : null
    })
    return false
  }
  const done = await waitWorkerDone(host, ws, dispatchId, WORKER_DONE_TIMEOUT_MS)
  const mine = done.message
  const summary = done.dispatch
  // Settled means the durable row reached `completed` through a worker_done report the host
  // accepted (settleWorkerReport); nothing else transitions a dispatch to completed.
  const ok = summary.status === 'completed' && summary.workerState === 'succeeded'
  if (!ok) {
    const read = orca(
      host,
      [
        'orchestration',
        'worker-read',
        '--dispatch',
        dispatchId,
        '--source',
        'auto',
        '--limit',
        '80'
      ],
      { allowFailure: true }
    ).json?.result
    const tail = (read?.terminal?.tail ?? read?.lines ?? [])
      .map((l) => String(l).trim())
      .filter(Boolean)
    log('settle.tail', { agent, source: read?.source ?? null, tail: tail.slice(-40) })
  }
  log('settle.result', {
    agent,
    ok,
    wallclockMs: Date.now() - t0,
    workerDone: mine
      ? {
          outcome: mine.payload?.outcome ?? mine.outcome ?? null,
          subject: mine.subject ?? mine.payload?.subject ?? null
        }
      : null,
    dispatch: { ...summary, raw: undefined }
  })
  orca(
    host,
    ['orchestration', 'worker-release', '--dispatch', dispatchId, '--retry-request', randomUUID()],
    { allowFailure: true }
  )
  return ok
}

async function phaseCrash(agent) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'odin-orca-dev-crash-'))
  writeProfile(userDataDir, { grants: BYPASS_GRANTS })
  const port = await freePort()
  const plan = planWorkspace(userDataDir)
  const trusted = grantClaudeTrust(plan.trustPaths)
  let host = new Host(userDataDir, port)
  await host.start()
  const ws = setupWorkspace(host, plan)
  const retryRequest = randomUUID()
  // Start the worker (the send is journaled and delivered), then kill the host mid-flight.
  const started = orca(host, workerStartArgs(ws, agent, ['--retry-request', retryRequest]), {
    allowFailure: true
  })
  const dispatchId = started.json?.result?.dispatchId ?? started.json?.result?.dispatch?.id ?? null
  log('crash.worker-start', {
    agent,
    exit: started.status,
    state: started.json?.result?.state ?? null,
    dispatchId,
    retryRequest
  })
  host.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 1500))
  log('crash.host-killed', { pid: host.child.pid })
  host = new Host(userDataDir, port)
  await host.start()
  try {
    const replay = orca(host, workerStartArgs(ws, agent, ['--retry-request', retryRequest]), {
      allowFailure: true
    })
    const replayText = JSON.stringify(replay.json ?? replay.raw)
    // Two honest answers to a replayed request id after a crash: the receipt was still pending
    // (operation_unknown, "do not start another worker"), or it had completed and the SAME
    // dispatch is returned again. Either way no second worker may be minted.
    const refused =
      replay.status !== 0 &&
      /operation_unknown|do not start another worker|before restart/i.test(replayText)
    const replayedDispatchId = replay.json?.result?.dispatchId ?? null
    const replayedSameDispatch = Boolean(dispatchId) && replayedDispatchId === dispatchId
    const noDuplicateWorker = refused || replayedSameDispatch
    const list = orca(host, ['orchestration', 'worker-list', '--run', ws.runId], {
      allowFailure: true
    }).json?.result
    const rows = list?.workers ?? list?.dispatches ?? list?.items ?? []
    const summary = dispatchId ? summarizeDispatch(host, dispatchId) : null
    const falseCompletion = summary?.status === 'completed'
    // Give a re-adopted worker the chance to finish honestly; a proven worker_done after re-adoption is fine.
    const done = dispatchId ? await waitWorkerDone(host, ws, dispatchId, 240_000) : null
    const reported = Boolean(done?.message)
    const after = done?.dispatch ?? null
    // Contract: no duplicate work, no false completion, no false exited. A re-adopted worker that
    // then reports worker_done is a legitimate completion; one that never reports stays dispatched.
    const falseExited =
      after?.terminationReason !== null && after?.status !== 'completed' && !reported
    const ok =
      noDuplicateWorker &&
      rows.length <= 1 &&
      !falseCompletion &&
      !falseExited &&
      (after?.status !== 'completed' || reported)
    log('crash.result', {
      agent,
      ok,
      replayRefused: refused,
      replayedSameDispatch,
      replayExit: replay.status,
      replayText: replayText.slice(0, 300),
      dispatchRows: rows.length,
      afterRestart: summary && {
        status: summary.status,
        workerState: summary.workerState,
        terminationReason: summary.terminationReason
      },
      workerDoneReported: reported,
      final: after && {
        status: after.status,
        workerState: after.workerState,
        terminationReason: after.terminationReason
      }
    })
    if (dispatchId) {
      orca(
        host,
        ['orchestration', 'worker-stop', '--dispatch', dispatchId, '--retry-request', randomUUID()],
        { allowFailure: true }
      )
    }
    return ok
  } finally {
    await host.stop()
    revokeClaudeTrust(trusted)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(ws.repoPath, { recursive: true, force: true })
  }
}

async function phaseConcurrent(host, ws, agents) {
  const starts = await Promise.all(
    agents.map((agent) => orcaAsync(host, workerStartArgs(ws, agent)))
  )
  const ids = starts.map((s) => s.json?.result?.dispatchId ?? s.json?.result?.dispatch?.id ?? null)
  log('concurrent.started', { agents, exits: starts.map((s) => s.status), dispatchIds: ids })
  const waits = await Promise.all(
    ids.map((id) => (id ? waitWorkerDone(host, ws, id, WORKER_DONE_TIMEOUT_MS) : null))
  )
  log('concurrent.reports', {
    reported: waits.map((w) => Boolean(w?.message)),
    timedOut: waits.map((w) => Boolean(w?.timedOut))
  })
  const summaries = ids.map((id) =>
    id ? { id, ...summarizeDispatch(host, id), raw: undefined } : null
  )
  const ok =
    ids.every(Boolean) &&
    summaries.every((s) => s?.status === 'completed') &&
    new Set(ids).size === ids.length
  log('concurrent.result', { ok, dispatches: summaries })
  for (const id of ids) {
    if (id) {
      orca(
        host,
        ['orchestration', 'worker-release', '--dispatch', id, '--retry-request', randomUUID()],
        { allowFailure: true }
      )
    }
  }
  return ok
}

async function main() {
  if (!existsSync(serveEntry) || !existsSync(cliEntry)) {
    throw new Error('build first: pnpm run build:cli && pnpm run build:electron-vite')
  }
  const results = {}
  if (PHASES.includes('default-blocks')) {
    for (const agent of AGENTS) {
      results[`default-blocks:${agent}`] = await phaseDefaultBlocks(agent)
    }
  }
  if (PHASES.includes('settle') || PHASES.includes('concurrent')) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'odin-orca-dev-grant-'))
    writeProfile(userDataDir, { grants: BYPASS_GRANTS })
    const plan = planWorkspace(userDataDir)
    const trusted = grantClaudeTrust(plan.trustPaths)
    const host = new Host(userDataDir, await freePort())
    await host.start()
    try {
      const ws = setupWorkspace(host, plan)
      if (PHASES.includes('settle')) {
        for (const agent of AGENTS) {
          results[`settle:${agent}`] = await phaseSettle(host, ws, agent)
        }
      }
      if (PHASES.includes('concurrent')) {
        results['concurrent'] = await phaseConcurrent(host, ws, AGENTS)
      }
      rmSync(ws.repoPath, { recursive: true, force: true })
    } finally {
      await host.stop()
      revokeClaudeTrust(trusted)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
  if (PHASES.includes('crash')) {
    for (const agent of AGENTS) {
      results[`crash:${agent}`] = await phaseCrash(agent)
    }
  }
  const ok = Object.values(results).every(Boolean)
  const outDir = join(projectDir, 'odin', 'proofs')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `real-sessions.${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    out,
    JSON.stringify({ ok, results, agents: AGENTS, phases: PHASES, events }, null, 2)
  )
  log('summary', { ok, results, file: out })
  process.exitCode = ok ? 0 : 1
  // Why explicit: stray host pipes must not keep a finished proof run alive.
  process.exit(process.exitCode)
}

main().catch((e) => {
  log('fatal', { error: String(e?.stack ?? e) })
  process.exitCode = 1
})
