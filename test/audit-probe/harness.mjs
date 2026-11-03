// audit-probe/harness.mjs — 用假宿主挂载真实插件（不改插件任何文件）
// 目的：测的是 apply() 的真实行为（注入块、工具返回、pre-step 提示），不是照抄 store 单测。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../index.js'

let seq = 0
export async function newStore() {
  seq++
  return mkdtemp(join(tmpdir(), `relay-audit-${process.pid}-${seq}-`))
}

export async function mount({ memoryDir, config = {}, services = {} } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const injected = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (n) => (n === 'systemPrompt'
      ? { section: () => {}, getSectionOrder: () => 10200 }
      : services[n]),
    effect: (fn) => { try { fn() } catch { /* ignore */ } },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    tools: { register: (t) => { tools.set(t.name, t) } },
  }
  apply(ctx, { enabled: true, memoryDir, alwaysOnSection: false, ...config })
  // ensureStore / storeStamps 是异步的，等一拍让初始指纹落定
  await new Promise((r) => setTimeout(r, 80))
  const call = async (name, args) => tools.get(name).execute(args ?? {}, {})
  const startup = async (source = 'startup', agent = {}) => {
    const a = {
      id: agent.id ?? 'agent-1',
      session: agent.session ?? { header: {} },
      inject: (m) => injected.push(m.content?.[0]?.text ?? ''),
      ...agent,
    }
    for (const h of handlers.get('agent/created') ?? []) await h({ agent: a, source })
    return injected[injected.length - 1] ?? ''
  }
  const preStep = async ({ agent = { id: 'agent-1', session: {} }, decision = { kind: 'enter', messages: [] } } = {}) => {
    let out = decision
    for (const h of handlers.get('agent/pre-step') ?? []) {
      out = await h({ agent }, async () => decision)
    }
    return out
  }
  return { tools, call, startup, preStep, injected, memoryDir, cleanup: () => rm(memoryDir, { recursive: true, force: true }) }
}

export const out = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

let failures = 0
let checks = 0
export function check(name, cond, detail = '') {
  checks++
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''}`)
  return cond
}
export function report(title) {
  console.log(`\n== ${title}: ${checks} checks, ${failures} failed ==\n`)
}
