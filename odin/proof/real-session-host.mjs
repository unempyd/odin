/**
 * Host, profile, trust and CLI plumbing for odin/proof/real-sessions.mjs (kept separate so each
 * file stays under Orca's max-lines budget). See that file for the phases and their meaning.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import process from 'node:process'

export const projectDir = resolve(import.meta.dirname, '../..')
export const serveEntry = join(projectDir, 'out', 'main', 'index.js')
export const cliEntry = join(projectDir, 'out', 'cli', 'index.js')
const READY_TIMEOUT_MS = 120_000
export const WORKER_DONE_TIMEOUT_MS = Number(process.env.ODIN_WORKER_DONE_TIMEOUT_MS ?? 420_000)
export const DEFAULT_BLOCK_WINDOW_MS = Number(process.env.ODIN_DEFAULT_BLOCK_WINDOW_MS ?? 90_000)
const SHUTDOWN_TIMEOUT_MS = 15_000

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
export const AGENTS = flag('agents', 'claude,codex,grok').split(',').filter(Boolean)
export const PHASES = flag('phase', 'default-blocks,settle,crash,concurrent').split(',')
// The explicit grants. This is the consent record: it is written into the throwaway profile and
// printed. Nothing in Odin/Orca adds these on its own (odin(H)).
export const BYPASS_GRANTS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  grok: '--permission-mode bypassPermissions'
}
export const SPEC =
  'Reply with the single word READY. Then, exactly as the instructions above describe, send worker_done with --outcome succeeded. Do nothing else.'

export const events = []
export function log(type, data = {}) {
  const row = { at: new Date().toISOString(), type, ...data }
  events.push(row)
  process.stdout.write(`${JSON.stringify(row)}\n`)
}

export async function freePort() {
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

export function writeProfile(userDataDir, { grants }) {
  // Why agentDefaultEnv: in a dev checkout the preamble tells workers to run `orca-dev`, whose
  // launcher targets ORCA_DEV_USER_DATA_PATH (default ~/Library/Application Support/orca-dev), not
  // the host the worker was started from. Pointing it at this throwaway profile keeps the worker's
  // worker_done on the same runtime. Production builds name `orca`, which reads ORCA_USER_DATA_PATH.
  const agentDefaultEnv = Object.fromEntries(
    AGENTS.map((agent) => [agent, { ORCA_DEV_USER_DATA_PATH: userDataDir }])
  )
  const profile = {
    settings: {
      telemetry: { optedIn: false, installId: randomUUID(), existedBeforeTelemetryRelease: false },
      agentStatusHooksEnabled: false,
      agentDefaultEnv,
      ...(grants ? { agentDefaultArgs: grants, agentYoloDefaultsMigrated: true } : {})
    },
    onboarding: { flowVersion: 4, closedAt: 1, outcome: 'completed', lastCompletedStep: 5 }
  }
  writeFileSync(join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
  log('profile', { userDataDir, consentRecord: grants ?? null })
}

/**
 * Decide the repo and worktree names before the host boots so the worktree path is known and can
 * be pre-trusted in the isolated Claude config (Orca pre-trusts folders for Codex, not for Claude;
 * a real Claude worker otherwise parks on the "Quick safety check" dialog and never becomes ready).
 */
export function planWorkspace(userDataDir) {
  const repoPath = seedGitRepo()
  const wtName = `odin-${randomBytes(3).toString('hex')}`
  const isolatedHome = join(userDataDir, 'home')
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 })
  const relative = join('orca', 'workspaces', basename(repoPath), wtName)
  const trustPaths = [
    join(isolatedHome, relative),
    join(realpathSync(isolatedHome), relative)
  ].filter((p, i, all) => all.indexOf(p) === i)
  return { repoPath, wtName, trustPaths }
}

/**
 * Worker terminals inherit the operator's real HOME (verified: a `terminal send 'echo $HOME'` under
 * a host started with an isolated HOME still prints the real one), so Claude reads the real
 * ~/.claude.json and its "Quick safety check" dialog parks the worker unless the worktree is
 * trusted there. Orca pre-trusts folders for Codex, not for Claude. The grant is the operator's
 * record: it is logged, scoped to the throwaway worktree paths, and removed on cleanup.
 */
const claudeConfigPath = join(process.env.HOME, '.claude.json')
export function grantClaudeTrust(paths) {
  // Only when a Claude worker is part of the run, and only with the operator's explicit opt-in.
  if (!AGENTS.includes('claude') || process.env.ODIN_GRANT_CLAUDE_TRUST !== '1') {
    log('trust.skipped', {
      agent: 'claude',
      reason: AGENTS.includes('claude')
        ? 'set ODIN_GRANT_CLAUDE_TRUST=1 to let the driver add a transient trust entry for the throwaway worktree to ~/.claude.json'
        : 'no claude worker in this run'
    })
    return []
  }
  if (!existsSync(claudeConfigPath)) {
    return []
  }
  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'))
  config.projects = config.projects ?? {}
  const added = []
  for (const p of paths) {
    if (config.projects[p]?.hasTrustDialogAccepted === true) {
      continue
    }
    config.projects[p] = { ...config.projects[p], hasTrustDialogAccepted: true }
    added.push(p)
  }
  if (added.length > 0) {
    writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2))
  }
  log('trust.granted', { agent: 'claude', file: claudeConfigPath, paths: added })
  return added
}
export function revokeClaudeTrust(paths) {
  if (paths.length === 0 || !existsSync(claudeConfigPath)) {
    return
  }
  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'))
  for (const p of paths) {
    delete config.projects?.[p]
  }
  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2))
  log('trust.revoked', { agent: 'claude', file: claudeConfigPath, paths })
}

export class Host {
  constructor(userDataDir, port) {
    this.userDataDir = userDataDir
    this.port = port
    this.child = null
  }
  async start() {
    // Why the binary and not node_modules/.bin/electron: that shim is a node wrapper, so a signal
    // sent to it leaves the real Electron main alive holding the single-instance lock (relaunch then
    // exits 3). Spawning the binary in its own process group makes the crash phase kill the host.
    const electron = createRequire(import.meta.url)('electron')
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
      { stdio: ['ignore', 'pipe', 'pipe'], env: hostEnv, detached: true }
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
      try {
        process.kill(-this.child.pid, signal) // the whole host process group
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
export function orca(host, args, { allowFailure = false } = {}) {
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

export async function orcaAsync(host, args) {
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
