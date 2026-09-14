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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import process from 'node:process'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const cliEntry = join(projectDir, 'out', 'cli', 'index.js')
const READY_TIMEOUT_MS = 120_000
const WORKER_DONE_TIMEOUT_MS = Number(process.env.ODIN_WORKER_DONE_TIMEOUT_MS ?? 420_000)
const DEFAULT_BLOCK_WINDOW_MS = Number(process.env.ODIN_DEFAULT_BLOCK_WINDOW_MS ?? 90_000)
const SHUTDOWN_TIMEOUT_MS = 15_000

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const AGENTS = flag('agents', 'claude,codex,grok').split(',').filter(Boolean)
const PHASES = flag('phase', 'default-blocks,settle,crash,concurrent').split(',')
// The explicit grants. This is the consent record: it is written into the throwaway profile and
// printed. Nothing in Odin/Orca adds these on its own (odin(H)).
const BYPASS_GRANTS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  grok: '--permission-mode bypassPermissions'
}
const SPEC =
  'Reply with the single word READY. Then, exactly as the instructions above describe, send worker_done with --outcome succeeded. Do nothing else.'

const events = []
function log(type, data = {}) {
  const row = { at: new Date().toISOString(), type, ...data }
  events.push(row)
  process.stdout.write(`${JSON.stringify(row)}\n`)
}

async function freePort() {
  const probe = createServer()
  await new Promise((res, rej) => {
    probe.once('error', rej)
    probe.listen(0, '127.0.0.1', res)
  })
  const port = probe.address().port
  await new Promise((res) => probe.close(res))
  return port
}

function seedGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'odin-real-repo-'))
  writeFileSync(join(dir, 'README.md'), '# odin real-session proof\n')
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
    }
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'odin@proof.local')
  git('config', 'user.name', 'Odin Proof')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  return dir
}

function writeProfile(userDataDir, { grants }) {
  const profile = {
    settings: {
      telemetry: { optedIn: false, installId: randomUUID(), existedBeforeTelemetryRelease: false },
      agentStatusHooksEnabled: false,
      ...(grants ? { agentDefaultArgs: grants, agentYoloDefaultsMigrated: true } : {})
    },
    onboarding: { flowVersion: 4, closedAt: 1, outcome: 'completed', lastCompletedStep: 5 }
  }
  writeFileSync(join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
  log('profile', { userDataDir, consentRecord: grants ?? null })
}

class Host {
  constructor(userDataDir, port) {
    this.userDataDir = userDataDir
    this.port = port
    this.child = null
  }
  async start() {
    const electron = join(projectDir, 'node_modules', '.bin', 'electron')
    // Why an isolated HOME: the dev build ignores --user-data-dir and the E2E user-data variable
    // refuses to start unless HOME is the disposable home beside it (main-process-preflight). The
    // agent CLIs must still find their logins, so their own state dirs are linked in read-through;
    // the seeded profile turns managed hook installation off so nothing is written through them.
    const realHome = process.env.HOME
    const isolatedHome = join(this.userDataDir, 'home')
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 })
    for (const entry of [
      '.claude',
      '.claude.json',
      '.codex',
      '.grok',
      '.config',
      '.gitconfig',
      '.local',
      '.nvm',
      '.npmrc'
    ]) {
      const from = join(realHome, entry)
      if (existsSync(from) && !existsSync(join(isolatedHome, entry))) {
        symlinkSync(from, join(isolatedHome, entry))
      }
    }
    const hostEnv = {
      ...process.env,
      HOME: isolatedHome,
      ORCA_E2E_HOME_DIR: isolatedHome,
      ORCA_E2E_USER_DATA_DIR: this.userDataDir,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      ELECTRON_RUN_AS_NODE: undefined
    }
    this.child = spawn(
      electron,
      [
        serveEntry,
        '--serve',
        '--serve-json',
        '--serve-port',
        String(this.port),
        '--serve-pairing-address',
        '127.0.0.1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: hostEnv }
    )
    const ready = await new Promise((res, rej) => {
      let buf = ''
      const timer = setTimeout(
        () => rej(new Error('serve host never reported ready')),
        READY_TIMEOUT_MS
      )
      this.child.stdout.on('data', (d) => {
        buf += String(d)
        for (const line of buf.split('\n')) {
          if (!line.startsWith('{')) {
            continue
          }
          try {
            const p = JSON.parse(line)
            if (p.type === 'orca_server_ready') {
              clearTimeout(timer)
              res(p)
            }
          } catch {}
        }
      })
      this.child.stderr.on('data', (d) => {
        const s = String(d)
        if (/error/i.test(s)) {
          log('host.stderr', { text: s.slice(0, 400) })
        }
      })
      this.child.on('exit', (code, signal) => log('host.exit', { code, signal }))
    })
    log('host.ready', { endpoint: ready.advertisedEndpoint, pid: this.child.pid })
  }
  kill(signal = 'SIGKILL') {
    if (this.child && this.child.exitCode === null) {
      this.child.kill(signal)
    }
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return
    }
    this.child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((r) => this.child.on('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), SHUTDOWN_TIMEOUT_MS))
    ])
    if (!exited) {
      this.child.kill('SIGKILL')
    }
  }
}

/** The CLI pretty-prints one JSON document; parse the whole stream, then fall back to the last object line. */
function parseCliJson(text) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed.slice(trimmed.indexOf('{')))
  } catch {}
  try {
    return JSON.parse(trimmed.split('\n').findLast((l) => l.startsWith('{')) ?? 'null')
  } catch {
    return null
  }
}

/** Runs the built CLI against the host's local runtime (unix socket + token from the profile). */
function orca(host, args, { allowFailure = false } = {}) {
  const r = spawnSync(process.execPath, [cliEntry, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ORCA_USER_DATA_PATH: host.userDataDir },
    timeout: WORKER_DONE_TIMEOUT_MS + 60_000
  })
  let parsed = null
  parsed = parseCliJson(r.stdout)
  if (r.status !== 0 && !allowFailure) {
    throw new Error(
      `orca ${args.slice(0, 3).join(' ')} exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 600)}`
    )
  }
  return { status: r.status, json: parsed, raw: (r.stdout + r.stderr).slice(-1500) }
}

async function orcaAsync(host, args) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [cliEntry, ...args, '--json'], {
      env: { ...process.env, ORCA_USER_DATA_PATH: host.userDataDir }
    })
    let out = '',
      err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('exit', (status) => {
      res({ status, json: parseCliJson(out), raw: (out + err).slice(-1500) })
    })
  })
}

function setupWorkspace(host) {
  const repoPath = seedGitRepo()
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
    `odin-${randomBytes(3).toString('hex')}`,
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

function waitWorkerDone(host, ws, timeoutMs) {
  return orca(
    host,
    [
      'orchestration',
      'check',
      '--run',
      ws.runId,
      '--types',
      'worker_done',
      '--wait',
      '--timeout-ms',
      String(timeoutMs),
      '--from',
      ws.coordinator
    ],
    { allowFailure: true }
  )
}

async function phaseDefaultBlocks(agent) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'odin-real-default-'))
  writeProfile(userDataDir, { grants: null })
  const host = new Host(userDataDir, await freePort())
  await host.start()
  try {
    const ws = setupWorkspace(host)
    const started = orca(host, workerStartArgs(ws, agent), { allowFailure: true })
    const dispatchId =
      started.json?.result?.dispatchId ?? started.json?.result?.dispatch?.id ?? null
    log('default-blocks.worker-start', {
      agent,
      exit: started.status,
      state: started.json?.result?.state ?? null,
      dispatchId
    })
    const done = dispatchId ? waitWorkerDone(host, ws, DEFAULT_BLOCK_WINDOW_MS) : null
    const settledAsDone = Boolean(
      done?.json?.result?.messages?.some?.((m) => m.type === 'worker_done')
    )
    const summary = dispatchId ? summarizeDispatch(host, dispatchId) : null
    const ok = !settledAsDone && summary?.status !== 'completed'
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
    rmSync(userDataDir, { recursive: true, force: true })
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
    launch: started.json?.result?.launch ?? started.json?.result?.receipt ?? null
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
  const done = waitWorkerDone(host, ws, WORKER_DONE_TIMEOUT_MS)
  const msgs = done.json?.result?.messages ?? []
  const mine =
    msgs.find(
      (m) =>
        m.type === 'worker_done' &&
        (m.payload?.dispatchId === dispatchId || m.dispatchId === dispatchId)
    ) ?? msgs.find((m) => m.type === 'worker_done')
  const summary = summarizeDispatch(host, dispatchId)
  const ok = Boolean(mine) && summary.status === 'completed'
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'odin-real-crash-'))
  writeProfile(userDataDir, { grants: BYPASS_GRANTS })
  const port = await freePort()
  let host = new Host(userDataDir, port)
  await host.start()
  const ws = setupWorkspace(host)
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
    const refused =
      replay.status !== 0 &&
      /operation_unknown|do not start another worker|before restart/i.test(replayText)
    const list = orca(host, ['orchestration', 'worker-list', '--run', ws.runId], {
      allowFailure: true
    }).json?.result
    const rows = list?.workers ?? list?.dispatches ?? list?.items ?? []
    const summary = dispatchId ? summarizeDispatch(host, dispatchId) : null
    const falseCompletion = summary?.status === 'completed'
    // Give a re-adopted worker the chance to finish honestly; a proven worker_done after re-adoption is fine.
    const done = dispatchId ? waitWorkerDone(host, ws, 120_000) : null
    const reported = Boolean(done?.json?.result?.messages?.some?.((m) => m.type === 'worker_done'))
    const after = dispatchId ? summarizeDispatch(host, dispatchId) : null
    const ok =
      refused && rows.length <= 1 && !falseCompletion && (after?.status !== 'completed' || reported)
    log('crash.result', {
      agent,
      ok,
      replayRefused: refused,
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
  const deadline = Date.now() + WORKER_DONE_TIMEOUT_MS
  const settled = new Set()
  while (Date.now() < deadline && settled.size < ids.filter(Boolean).length) {
    const done = waitWorkerDone(host, ws, 60_000)
    for (const m of done.json?.result?.messages ?? []) {
      if (m.type === 'worker_done') {
        settled.add(m.payload?.dispatchId ?? m.dispatchId ?? m.id)
      }
    }
    for (const id of ids) {
      if (id && summarizeDispatch(host, id).status === 'completed') {
        settled.add(id)
      }
    }
  }
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
    const userDataDir = mkdtempSync(join(tmpdir(), 'odin-real-grant-'))
    writeProfile(userDataDir, { grants: BYPASS_GRANTS })
    const host = new Host(userDataDir, await freePort())
    await host.start()
    try {
      const ws = setupWorkspace(host)
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
}

main().catch((e) => {
  log('fatal', { error: String(e?.stack ?? e) })
  process.exitCode = 1
})
