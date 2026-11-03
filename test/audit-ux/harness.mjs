// audit-ux/harness.mjs — 最小假宿主，挂真实 apply()，只打印工具真实返回。
// 只读插件代码；本目录是唯一写入。所有库建在 %TEMP%\relay-ux-*。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../index.js'

let seq = 0
export async function newStore() {
  seq++
  return mkdtemp(join(tmpdir(), `relay-ux-${process.pid}-${seq}-`))
}

export async function mount({ memoryDir, config = {}, withSystemPrompt = true, services = {} } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const injected = []
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (n) => (n === 'systemPrompt'
      ? (withSystemPrompt
        ? { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 10200 }
        : undefined)
      : services[n]),
    effect: (fn) => { try { fn() } catch { /* ignore */ } },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    tools: { register: (t) => { tools.set(t.name, t) } },
  }
  apply(ctx, { enabled: true, memoryDir, ...config })
  await new Promise((r) => setTimeout(r, 80))
  const call = async (name, args = {}) => {
    const t = tools.get(name)
    if (!t) return `[no such tool: ${name}]`
    try {
      return await t.execute(args, {})
    } catch (e) {
      return `[THREW] ${e?.name}: ${e?.message}`
    }
  }
  const startup = async (source = 'startup') => {
    const agent = {
      id: 'agent-1',
      session: { header: {} },
      inject: (m) => injected.push(m.content?.[0]?.text ?? ''),
    }
    for (const h of handlers.get('agent/created') ?? []) await h({ agent, source })
    return injected[injected.length - 1] ?? ''
  }
  const preStep = async ({ agent = { id: 'agent-1', session: {} }, decision = { kind: 'enter', messages: [] } } = {}) => {
    let out = decision
    for (const h of handlers.get('agent/pre-step') ?? []) out = await h({ agent }, async () => decision)
    return out
  }
  return {
    tools, call, startup, preStep, injected, sections, memoryDir, handlers,
    cleanup: () => rm(memoryDir, { recursive: true, force: true }),
  }
}

export function head(title) {
  console.log(`\n\n================ ${title} ================`)
}
export function show(label, value) {
  console.log(`\n--- ${label} ---\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
}
