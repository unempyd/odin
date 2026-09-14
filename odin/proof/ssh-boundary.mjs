#!/usr/bin/env node
/**
 * Odin real SSH-host boundary proof — drives a real Orca desktop host against a real SSH target
 * (claw-vps) and records what the durable rows say when contact is lost and regained.
 *
 * Why desktop mode and not `--serve` (see odin/proof/real-session-host.mjs): SSH mutation
 * (ssh:addTarget) is IPC-only, and IPC handlers install only from a BrowserWindow
 * (src/main/window/attach-main-window-services.ts:121). Headless `--serve` returns before
 * openMainWindow ever runs (src/main/startup/main-process-runtime-launch.ts:340-343), so it can
 * never expose SSH mutation. There is also no CLI/RPC path that registers an SSH target at all —
 * `sshTargets` must be seeded on disk before boot (src/main/persistence/loading-store/
 * normalize-loaded-profile-state.ts:90). This driver launches Electron with no `--serve` args
 * (desktop mode), keeps ORCA_BACKGROUND_LAUNCH=1 so the window never reaches the screen
 * (src/main/window/foreground-activation-policy.ts:17-34), and polls `orca status --json`
 * for readiness instead of the `orca_server_ready` stdout line (which only serve mode prints).
 *
 * Phases: see docs/reference/ssh-execution-boundary.md and odin/proofs/ssh-boundary.md for the
 * narrated results. Output: NDJSON on stdout, summary JSON written to
 * odin/proofs/ssh-boundary.<ts>.json.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import process from 'node:process'
import { cliEntry, events, log, orca, projectDir, serveEntry } from './real-session-host.mjs'

const SSH_HOST = process.env.ODIN_SSH_PROOF_HOST ?? 'claw-vps'
const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const REMOTE_ROOT = '/root/odin-proof'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── Remote (VPS) command helpers ───────────────────────────────────────────

function ssh(cmd, { allowFailure = false, timeoutMs = 30_000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', SSH_HOST, cmd], {
    encoding: 'utf8',
    timeout: timeoutMs
  })
  const result = {
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim()
  }
  log('vps.exec', { cmd, ...result })
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`ssh ${SSH_HOST} '${cmd}' exit ${r.status}: ${result.stderr || result.stdout}`)
  }
  return result
}

/** Our Mac's public IP as the VPS's own kernel sees it (first field of $SSH_CONNECTION). */
function macIpFromVpsPerspective() {
  const r = ssh('echo $SSH_CONNECTION')
  const ip = r.stdout.split(/\s+/)[0]
  if (!ip) {
    throw new Error(`could not parse SSH_CONNECTION from VPS: ${r.stdout}`)
  }
  return ip
}

function resolvedSshTargetFields() {
  const g = spawnSync('ssh', ['-G', SSH_HOST], { encoding: 'utf8' }).stdout
  const field = (name) => g.match(new RegExp(`^${name} (.+)$`, 'm'))?.[1]?.trim()
  const identityRaw = field('identityfile')
  const identityFile = identityRaw?.replace(/^~/, process.env.HOME)
  return {
    hostname: field('hostname'),
    port: Number(field('port') ?? '22'),
    username: field('user'),
    identityFile
  }
}

// ─── Remote repo seed (plan §2.2) ───────────────────────────────────────────

function seedRemoteRepo() {
  const cmd = [
    `mkdir -p ${REMOTE_ROOT}`,
    `rm -rf ${REMOTE_ROOT}/seed`,
    `cd ${REMOTE_ROOT}`,
    `git init -q -b main seed`,
    `cd seed`,
    `git config user.email odin@proof.local`,
    `git config user.name 'Odin Proof'`,
    `printf '# odin ssh proof\\n' > README.md`,
    `git add -A`,
    `git commit -qm seed`,
    `git rev-parse HEAD`
  ].join(' && ')
  const r = ssh(cmd)
  const head = r.stdout.trim().split('\n').pop()
  log('vps.repo-seeded', { path: `${REMOTE_ROOT}/seed`, head })
  return head
}

// ─── Profile seeding (plan §2.1/§2.2 — no CLI/RPC path registers an SSH target) ─────────────

function writeSshProfile(userDataDir, { targetId, repoId, resolved }) {
  const profile = {
    settings: {
      telemetry: { optedIn: false, installId: randomUUID(), existedBeforeTelemetryRelease: false },
      agentStatusHooksEnabled: false
    },
    onboarding: { flowVersion: 4, closedAt: 1, outcome: 'completed', lastCompletedStep: 5 },
    sshTargets: [
      {
        id: targetId,
        label: 'claw-vps',
        configHost: 'claw-vps',
        host: resolved.hostname,
        port: resolved.port,
        username: resolved.username,
        identityFile: resolved.identityFile,
        // Why 'manual': never overwritten by a later ~/.ssh/config import
        // (src/main/ssh/ssh-connection-store.ts:41-44).
        source: 'manual',
        generation: 1,
        // Why 0: keep alive until reset — the survival default we are exercising
        // (src/shared/ssh-types.ts:44-46).
        relayGracePeriodSeconds: 0
      }
    ],
    repos: [
      {
        id: repoId,
        path: `${REMOTE_ROOT}/seed`,
        displayName: 'odin-ssh-proof',
        badgeColor: '#888',
        addedAt: Date.now(),
        kind: 'git',
        connectionId: targetId,
        executionHostId: `ssh:${targetId}`
      }
    ]
  }
  writeFileSync(join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
  log('profile', { userDataDir, targetId, repoId })
}

// ─── Minimal runtime RPC client (deviation: no public CLI verb calls ssh.connect) ───────────
// Reimplements the wire protocol from src/cli/runtime/transport.ts against
// <userDataDir>/orca-runtime.json (src/shared/runtime-bootstrap.ts) rather than importing the
// bundled CLI internals, which are not exposed as an importable module from out/cli/index.js.

function readRuntimeMetadata(userDataDir) {
  return JSON.parse(readFileSync(join(userDataDir, 'orca-runtime.json'), 'utf8'))
}

function rpcCall(userDataDir, method, params, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    let metadata
    try {
      metadata = readRuntimeMetadata(userDataDir)
    } catch (e) {
      reject(e)
      return
    }
    const transport = (metadata.transports ?? []).find((t) => t.kind === 'unix')
    if (!transport) {
      reject(new Error('no unix transport in runtime metadata'))
      return
    }
    const id = randomUUID()
    const socket = createConnection(transport.endpoint)
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      reject(new Error(`rpc timeout: ${method}`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.once('error', (e) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    socket.on('data', (chunk) => {
      buf += chunk
      let idx
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim() || settled) {
          continue
        }
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (frame._keepalive) {
          timer.refresh()
          continue
        }
        if (frame.id !== id) {
          continue
        }
        settled = true
        clearTimeout(timer)
        socket.end()
        if (frame.ok === false) {
          reject(new Error(JSON.stringify(frame.error)))
        } else {
          resolve(frame.result)
        }
        return
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`)
    })
  })
}

// ─── Desktop-mode host (deviation from real-session-host.mjs Host — see file header) ────────

class DesktopHost {
  constructor(userDataDir) {
    this.userDataDir = userDataDir
    this.child = null
  }
  async start() {
    const electron = createRequire(import.meta.url)('electron')
    const realHome = process.env.HOME
    const isolatedHome = join(this.userDataDir, 'home')
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 })
    // '.ssh' added (beyond real-session-host.mjs's list) so known_hosts trust for claw-vps
    // (already recorded under the real HOME) is visible without re-doing host-key TOFU headless.
    for (const entry of [
      '.claude',
      '.claude.json',
      '.codex',
      '.grok',
      '.config',
      '.gitconfig',
      '.local',
      '.nvm',
      '.npmrc',
      '.ssh'
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
      // Deviation (found empirically, see odin/proofs/ssh-boundary.md): a bare `electron
      // out/main/index.js` dev launch does not resolve app.getAppPath() the way `pnpm dev` does,
      // so getLocalRelayCandidates() (src/main/ssh/ssh-relay-deploy.ts:1646-1673) never finds the
      // locally-bundled relay and ssh.connect fails with the masked "SSH connection unavailable"
      // before any bytes reach the VPS. ORCA_RELAY_PATH is the documented override for exactly
      // this. It must be the REALPATH: this repo is a git worktree whose out/ is a symlink to the
      // main checkout, and the relay upload's own path-containment guard rejects a symlinked
      // root as "escaped" — realpathSync resolves to the same on-disk files without weakening
      // that guard.
      ORCA_RELAY_PATH: realpathSync(join(projectDir, 'out', 'relay')),
      ELECTRON_RUN_AS_NODE: undefined
    }
    delete hostEnv.ORCA_E2E_HEADLESS
    // Deviation from real-session-host.mjs Host.start(): no --serve argv, desktop mode.
    this.child = spawn(electron, [serveEntry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: hostEnv,
      detached: true
    })
    this.child.stdout.on('data', (d) => {
      const s = String(d)
      if (/error|\[ssh/i.test(s)) {
        log('host.stdout', { text: s.slice(0, 2000) })
      }
    })
    this.child.stderr.on('data', (d) => {
      const s = String(d)
      if (/error|\[ssh/i.test(s)) {
        log('host.stderr', { text: s.slice(0, 2000) })
      }
    })
    this.child.on('exit', (code, signal) => log('host.exit', { code, signal }))
    const deadline = Date.now() + READY_TIMEOUT_MS
    let lastStatus = null
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`desktop host exited before ready (code=${this.child.exitCode})`)
      }
      const r = orca(this, ['status'], { allowFailure: true })
      lastStatus = r.json?.result ?? null
      if (lastStatus?.runtime?.state === 'ready') {
        log('host.ready', { pid: this.child.pid, status: lastStatus })
        return
      }
      await sleep(1000)
    }
    throw new Error(`desktop host never reported ready: ${JSON.stringify(lastStatus)}`)
  }
  kill(signal = 'SIGKILL') {
    if (this.child && this.child.exitCode === null) {
      try {
        process.kill(-this.child.pid, signal)
      } catch {
        this.child.kill(signal)
      }
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
    this.kill(exited ? 'SIGTERM' : 'SIGKILL')
    this.child.stdout?.destroy()
    this.child.stderr?.destroy()
    const mine = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((l) => l.includes(this.userDataDir))
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid)
    for (const pid of mine) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    if (mine.length > 0) {
      log('host.daemons-reaped', { pids: mine })
    }
  }
}

// ─── Verdict helpers ─────────────────────────────────────────────────────────

function terminalShow(host, term) {
  return orca(host, ['terminal', 'show', '--terminal', term], { allowFailure: true }).json?.result
    ?.terminal
}
// Why not `.state`: `terminal show` (RuntimeTerminalSummary, src/shared/runtime-terminal-contracts.ts)
// carries no such field — this driver's original phase3/4/5/6/7 verdicts checked one that has never
// existed and always evaluated to `undefined`, which happened to read as truthy for the `!== 'exited'`
// checks and always false for the `=== 'running'`/`'exited'` ones. Never caught because no prior run
// ever reached a connected session to exercise these checks. Liveness here is `connected` plus the
// absence/presence of `exitCause` (src/shared/terminal-exit-cause.ts) — the same vocabulary
// docs/reference/ssh-execution-boundary.md documents: exitCause absent means running or merely
// unverifiable, never a claimed exit; present means the host is vouching for a real exit.
function terminalIsRunning(show) {
  return show?.connected === true && !show?.exitCause
}
function terminalClaimsExit(show) {
  return Boolean(show?.exitCause)
}
function worktreePs(host) {
  return orca(host, ['worktree', 'ps'], { allowFailure: true }).json?.result
}
function terminalWaitExit(host, term, timeoutMs = 15_000) {
  const r = orca(
    host,
    ['terminal', 'wait', '--terminal', term, '--for', 'exit', '--timeout-ms', String(timeoutMs)],
    {
      allowFailure: true
    }
  )
  if (!r.json?.result?.wait) {
    log('terminalWaitExit.raw', { status: r.status, raw: r.raw })
  }
  return r.json?.result?.wait
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(serveEntry) || !existsSync(cliEntry)) {
    throw new Error('build first: pnpm run build:cli && pnpm run build:electron-vite')
  }
  const record = { phases: {} }
  const userDataDir = mkdtempSync(join(tmpdir(), 'odin-ssh-proof-'))
  const targetId = `ssh-${Date.now()}-${randomBytes(3).toString('hex')}`
  const repoId = `repo-${Date.now()}-${randomBytes(3).toString('hex')}`
  let host = null
  let macIp = null
  let head = null

  try {
    // ── Phase 1: seed + boot desktop host ──────────────────────────────
    macIp = macIpFromVpsPerspective()
    log('phase1.mac-ip', { macIp })
    head = seedRemoteRepo()
    const resolved = resolvedSshTargetFields()
    log('phase1.resolved-target', resolved)
    writeSshProfile(userDataDir, { targetId, repoId, resolved })
    host = new DesktopHost(userDataDir)
    await host.start()
    record.phases.phase1 = { ok: true, macIp, head, resolved }

    // ── Phase 2: host list, ssh.connect, verify relay on VPS ───────────
    const hostList = orca(host, ['host', 'list']).json?.result?.hosts ?? []
    const sshRow = hostList.find((h) => h.kind === 'ssh' && h.id === targetId)
    log('phase2.host-list', { hosts: hostList, sshRow })
    if (!sshRow) {
      throw new Error('host list did not show the seeded ssh target')
    }

    // Why 60s and not several short retries: real deploy + first-connect (upload, native-deps
    // link, relay launch, pty.openClient) has taken up to ~20s against claw-vps; one generous
    // window beats retries that would just restart the same deploy. Deviation 3
    // (odin/proofs/ssh-boundary.md) used to make this hang indefinitely regardless of timeout —
    // fixed at the root (src/main/host/electron-secret-store.ts); see the deviation entry.
    let connectState = null
    let connectError = null
    try {
      connectState = await rpcCall(userDataDir, 'ssh.connect', { targetId }, 60_000)
    } catch (e) {
      connectError = e
    }
    log('phase2.ssh-connect', { connectState, connectError: connectError && String(connectError) })

    await sleep(2000)
    const relayCheck = ssh(
      'ls -d ~/.orca-remote/relay-* 2>/dev/null; ' +
        'ls -l ~/.orca-remote/relay-*/*.sock 2>/dev/null; ' +
        'pgrep -af "relay\\.js --detached"',
      { allowFailure: true }
    )
    record.phases.phase2 = {
      ok: Boolean(sshRow) && connectState?.state?.status === 'connected',
      sshRow,
      connectState,
      relayCheck
    }

    if (connectState?.state?.status !== 'connected') {
      // Why stop here: phases 3-7 all build on a live, connected relay (worktree/terminal
      // creation on the ssh: host, then the loss-of-contact matrix). Without a connected state
      // there is nothing to lose contact WITH, and every downstream verdict would be an artifact
      // of the missing connection rather than of the boundary contract under test. See the
      // documented deviation (odin/proofs/ssh-boundary.md) for the evidence trail.
      record.phases.phase3to7 = {
        ok: false,
        skipped: true,
        reason: 'ssh.connect never reached status:connected; see phase2 and the deviation note'
      }
      log('phases3to7.skipped', record.phases.phase3to7)
      throw new Error('stopping after phase 2: target never reached connected state')
    }

    // ── Phase 3: worktree + terminal + sleep 600, baseline verdicts ────
    const wtName = `odin-ssh-${randomBytes(3).toString('hex')}`
    const wt = orca(host, [
      'worktree',
      'create',
      '--repo',
      `id:${repoId}`,
      '--name',
      wtName,
      '--setup',
      'skip'
    ]).json?.result?.worktree
    if (!wt?.id) {
      throw new Error('worktree create returned no id')
    }
    const term = orca(host, ['terminal', 'create', '--worktree', wt.id]).json?.result?.terminal
    if (!term?.handle) {
      throw new Error('terminal create returned no handle')
    }
    orca(host, ['terminal', 'send', '--terminal', term.handle, '--text', 'sleep 600', '--enter'])
    await sleep(2000)
    const baselineShow = terminalShow(host, term.handle)
    const baselinePs = worktreePs(host)
    const vpsSleep = ssh(
      'ps -eo pid,ppid,pgid,tpgid,stat,tty,etimes,command | grep "sleep 600" | grep -v grep'
    )
    const [sleepPid, shellPid] = vpsSleep.stdout.trim().split(/\s+/)
    log('phase3.baseline', {
      baselineShow,
      baselinePs,
      vpsSleep: vpsSleep.stdout,
      sleepPid,
      shellPid
    })
    record.phases.phase3 = {
      ok: terminalIsRunning(baselineShow) && Boolean(sleepPid),
      worktreeId: wt.id,
      terminal: term.handle,
      baselineShow,
      baselinePs,
      sleepPid,
      shellPid
    }

    // ── Phase 4: loss of contact — variant C, self-healing iptables from the VPS ────────
    const blockWindowSec = 75
    ssh(
      `nohup sh -c 'iptables -I INPUT -s ${macIp} -j DROP; sleep ${blockWindowSec}; iptables -D INPUT -s ${macIp} -j DROP' >/dev/null 2>&1 & disown; echo armed`
    )
    log('phase4.rule-armed', { macIp, blockWindowSec })
    await sleep(10_000)
    const duringShow = terminalShow(host, term.handle)
    const duringPs = worktreePs(host)
    const duringWait = terminalWaitExit(host, term.handle, 30_000)
    // Why `ok` rests on `duringShow` alone: `terminal.wait` rejects with a bare `Error('timeout')`
    // (not a resolved `{satisfied:false}`) when the SSH transport's own dead-link detection
    // (TIMEOUT_MS, src/relay/protocol.ts) has not yet flipped `pty.connected` by the time our
    // requested wait budget elapses — a real race, not a hang. `duringWait` is recorded as
    // evidence; the core boundary contract under test is `terminal show` never claiming `exited`.
    record.phases.phase4 = {
      ok: !terminalClaimsExit(duringShow),
      duringShow,
      duringPs,
      duringWait
    }
    log('phase4.verdicts', record.phases.phase4)

    // Wait out the rest of the self-healing window before reconnect.
    const remaining = blockWindowSec * 1000 + 5000 - 10_000
    if (remaining > 0) {
      await sleep(remaining)
    }

    // ── Phase 5: reconnect re-adopts ────────────────────────────────────
    const reconnectState = await rpcCall(userDataDir, 'ssh.connect', { targetId }).catch((e) => ({
      error: String(e)
    }))
    await sleep(3000)
    const afterReconnectShow = terminalShow(host, term.handle)
    const vpsSleepAfter = ssh('pgrep -af "sleep 600"', { allowFailure: true })
    const samePid = vpsSleepAfter.stdout.includes(String(sleepPid))
    record.phases.phase5 = {
      ok: terminalIsRunning(afterReconnectShow) && samePid,
      reconnectState,
      afterReconnectShow,
      vpsSleepAfter: vpsSleepAfter.stdout,
      samePid
    }
    log('phase5.verdicts', record.phases.phase5)
    const ruleGoneCheck = ssh(`iptables -S INPUT | grep ${macIp} || true`, { allowFailure: true })
    record.phases.phase5.ruleGoneAfterExpiry = ruleGoneCheck.stdout === ''

    // ── Phase 6: owner-proven exit ───────────────────────────────────────
    // Why the shell, not `sleep 600`: node-pty's exit event (what the runtime's terminal-exit
    // tracking is keyed to) fires when the PTY's own controlling process — the login shell — exits,
    // not when a job running inside it does. Killing only `sleep 600` leaves the shell alive to
    // print a fresh prompt, so `terminal show` never sees an exit at all; that is correct behavior,
    // not the boundary condition this phase means to exercise. Kill the shell to get a real exit.
    ssh(`kill -9 ${shellPid}`)
    await sleep(2000)
    const exitedShow = terminalShow(host, term.handle)
    const exitedWait = terminalWaitExit(host, term.handle, 20_000)
    // Why re-poll `show` after the wait attempt rather than trust the wait alone: `terminal.wait`
    // (src/main/runtime/runtime-terminal-wait.ts) rejects with a bare `Error('timeout')` — not a
    // resolved `{satisfied:false}` — when its own internal timer fires before either an exit or a
    // disconnect resolves the waiter, which the CLI surfaces as an RPC error the driver cannot read
    // a verdict from. `terminal show`'s `exitCause` is populated independently of the wait path, so
    // it stays the authoritative check; the wait's outcome is recorded for evidence only.
    // Why poll for up to 45s more: confirming this is "never observed", not merely "not observed
    // yet" — a real find either way, but a very different one.
    let exitedShowAfterWait = terminalShow(host, term.handle)
    const exitPollDeadline = Date.now() + 45_000
    while (!terminalClaimsExit(exitedShowAfterWait) && Date.now() < exitPollDeadline) {
      await sleep(5000)
      exitedShowAfterWait = terminalShow(host, term.handle)
    }
    const shellStillAliveOnHost = ssh(
      `ps -p ${shellPid} >/dev/null 2>&1 && echo alive || echo dead`
    ).stdout
    record.phases.phase6 = {
      ok: terminalClaimsExit(exitedShowAfterWait),
      exitedShow,
      exitedWait,
      exitedShowAfterWait,
      shellStillAliveOnHost
    }
    log('phase6.verdicts', record.phases.phase6)

    // ── Phase 7: variant B — relay SIGKILL, then relaunch via ssh.connect ────────────────
    const wt2Name = `odin-ssh-${randomBytes(3).toString('hex')}`
    const wt2 = orca(host, [
      'worktree',
      'create',
      '--repo',
      `id:${repoId}`,
      '--name',
      wt2Name,
      '--setup',
      'skip'
    ]).json?.result?.worktree
    if (!wt2?.id) {
      throw new Error('phase7 worktree create returned no id')
    }
    const term2 = orca(host, ['terminal', 'create', '--worktree', wt2.id]).json?.result?.terminal
    if (!term2?.handle) {
      throw new Error('phase7 terminal create returned no handle')
    }
    orca(host, ['terminal', 'send', '--terminal', term2.handle, '--text', 'sleep 600', '--enter'])
    await sleep(2000)
    const relayPidBefore = ssh('pgrep -f "relay\\.js --detached"', { allowFailure: true }).stdout
    ssh('pkill -9 -f "relay\\.js --detached"', { allowFailure: true })
    await sleep(5000)
    const bShow = terminalShow(host, term2.handle)
    const bPs = worktreePs(host)
    const bWait = terminalWaitExit(host, term2.handle, 20_000)
    // Why `ok` rests on `bShow` alone: see the phase4 note above — same `terminal.wait` rejection
    // shape on a lost relay.
    record.phases.phase7 = {
      ok: !terminalClaimsExit(bShow),
      relayPidBefore,
      bShow,
      bPs,
      bWait
    }
    log('phase7.b-verdicts', record.phases.phase7)
    const relaunch = await rpcCall(userDataDir, 'ssh.connect', { targetId }).catch((e) => ({
      error: String(e)
    }))
    await sleep(3000)
    record.phases.phase7.relaunch = relaunch
    log('phase7.relaunch', relaunch)
  } catch (e) {
    record.fatal = String(e?.stack ?? e)
    log('main.fatal', { error: record.fatal })
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    if (host) {
      await host.stop()
    }
    ssh(`rm -rf ${REMOTE_ROOT}`, { allowFailure: true })
    if (macIp) {
      const leftoverRule = ssh(`iptables -S INPUT | grep ${macIp} || true`, { allowFailure: true })
      if (leftoverRule.stdout.trim() !== '') {
        ssh(`iptables -D INPUT -s ${macIp} -j DROP`, { allowFailure: true })
      }
      const finalCheck = ssh(`iptables -S INPUT | grep ${macIp} || true`, { allowFailure: true })
      record.iptablesClean = finalCheck.stdout.trim() === ''
      log('cleanup.iptables', { finalCheck: finalCheck.stdout, clean: record.iptablesClean })
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }

  const ok = !record.fatal && Object.values(record.phases).every((p) => p?.ok !== false)
  const outDir = join(projectDir, 'odin', 'proofs')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `ssh-boundary.${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(out, JSON.stringify({ ok, ...record, events }, null, 2))
  log('summary', { ok, file: out })
  process.exitCode = ok ? 0 : 1
  process.exit(process.exitCode)
}

main().catch((e) => {
  log('fatal', { error: String(e?.stack ?? e) })
  process.exitCode = 1
  process.exit(1)
})
