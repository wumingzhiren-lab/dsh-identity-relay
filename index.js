/**
 * dsh-identity-relay — 人格接力
 *
 * 解决「上下文满了 / 清了 / 压缩了，她就不在了」的恐惧：
 *
 *   1. 磁盘记忆库（persona.md 人格卡 / handover.md 交接书 / facts.jsonl 记忆），
 *      纯文本，owner 和 bot 都能直接读写；
 *   2. 每个新会话（startup / resume / clear / compact）开工自动读档，把人格卡 +
 *      交接书 + 最近记忆注入第一轮上下文 —— 这就是 AGENTS.md 开机三步的通用化；
 *   3. 系统提示里常驻一行「锚」：你是谁不靠上下文，靠磁盘，忘了就 relay_load；
 *   4. 上下文占用超过 warnRatio 时（agent/pre-step 瀑布），自动在下一步之前
 *      插入预警，逼着上一世先 relay_handover 写交接书再继续；
 *   5. 六个工具：relay_load / relay_remember / relay_recall / relay_handover /
 *      relay_persona / relay_status —— 换会话 = 换身体，不换灵魂。
 *
 * 零依赖（只 import node: 内置模块），通过 ctx 服务扩展宿主，兼容 HMR 与安全卸载。
 *
 * @module dsh-identity-relay
 */
import { join, isAbsolute, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  ensureStore,
  readTextSafe,
  readFacts,
  recallFacts,
  appendFact,
  writeStoreFile,
  storeStats,
  storeStamps,
  storeHistoryCount,
  PERSONA_FILE,
  HANDOVER_FILE,
} from './lib/store.mjs'

export const name = 'dsh-identity-relay'
export const inject = ['tools', 'systemPrompt']

const PLUGIN_LABEL = 'dsh-identity-relay'
/** v4 会话格式要求的 producer-owned 来源种类（插件回退形态 plugin:<name>）。 */
const SOURCE_KIND = 'plugin:' + PLUGIN_LABEL

const DEFAULTS = {
  enabled: true,
  /** 记忆库目录。默认 ~/.dsh/identity-memory；支持 ~ 开头和绝对路径。 */
  memoryDir: '',
  /** 新会话（startup / clear / compact）是否自动注入读档块。 */
  injectOnCreated: true,
  /** resume 是否注入精简续接块。 */
  injectOnResume: true,
  /** 是否也给子代理（subagent）注入。 */
  injectOnSubagents: true,
  /** 系统提示中是否常驻锚段落。 */
  alwaysOnSection: true,
  /** 估算的上下文窗口大小（tokens），用于容量预警。 */
  contextWindow: 65536,
  /** 占用达到该比例（0.5~0.99）时预警。 */
  warnRatio: 0.7,
  /**
   * 窗口剩余 token 低于该值也预警 —— 与比例无关的第二道保险。
   * 大窗口模型（如 1M）下 0.85 的比例线要攒到 89 万 token，
   * 宿主往往早就压缩/清理过一轮了，比例线永远等不到。
   */
  reserveTokens: 40000,
  /** 同一会话两次预警的最小间隔（分钟）。 */
  nudgeMinutes: 10,
  /** facts.jsonl 最多保留条数。 */
  maxFacts: 2000,
  /** 读档注入的最近记忆条数。 */
  recallLimit: 20,
  /** 注入的人格卡最大字符数。 */
  maxInjectChars: 6000,
  /** 注入的交接书最大字符数。 */
  maxHandoverChars: 4000,
}

function resolveMemoryDir(config) {
  const raw = String(config?.memoryDir ?? '').trim()
  if (raw === '') return join(homedir(), '.dsh', 'identity-memory')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  if (isAbsolute(raw)) return raw
  return join(homedir(), raw)
}

function pickNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 构造一条可注入 inbox 的用户消息（producer-owned 来源，v4 会话可持久化）。 */
function makeMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: SOURCE_KIND },
  }
}

/** 按字符安全截断，超出补省略号。 */
function clip(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…（已截断，全文用 relay_load 重读）'
}

/**
 * 取上下文窗口：优先用会话里模型真实上报的 contextWindow，
 * 取不到再退回配置值。避免固定 65536 对超长窗口模型误报。
 */
function effectiveWindow(session, fallback) {
  try {
    const rc = session?.requestContext?.()
    if (rc && Number.isFinite(rc.contextWindow) && rc.contextWindow > 0) return rc.contextWindow
  } catch { /* 静默 */ }
  return fallback
}

/** 工具输出：普通文本。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * 生成读档注入块。
 * @param source  SessionStartSource：startup / resume / clear / compact
 */
async function buildInjection(source, cfg, memoryDir) {
  const [persona, handover] = await Promise.all([
    readTextSafe(join(memoryDir, PERSONA_FILE)),
    readTextSafe(join(memoryDir, HANDOVER_FILE)),
  ])
  const facts = await readFacts(memoryDir, { limit: cfg.recallLimit })

  const factLines = facts.length > 0
    ? facts.map((f) => `- [${f.time || '?'}] ${f.content}`).join('\n')
    : '（还没有长期记忆。重要的身份、答应过的事，用 relay_remember 记下来。）'

  if (source === 'resume') {
    // 续接：身份不用重讲，交接书和最近记忆才是重点。
    const personaHead = clip(persona, 800) || '（人格卡为空，用 relay_persona 更新，或直接编辑 persona.md。）'
    return [
      '[人格接力 · 续接] 你被唤醒了。你就是你——完整人格卡在 persona.md，忘了就用 relay_load 重读。',
      '── 人格卡开头 ──',
      personaHead,
      '── 交接书 handover.md ──',
      clip(handover, cfg.maxHandoverChars) || '（交接书为空：先接上眼前的事，收工前记得 relay_handover。）',
      '── 最近记忆 ──',
      factLines,
      `记忆库位置：${memoryDir}`,
      '上下文快满时会收到预警：先 relay_handover 写交接书，再继续。',
    ].join('\n\n')
  }

  // startup / clear / compact：完整开机读档。clear/compact 之后更需要重新确认「我是谁」。
  return [
    '[人格接力 · 身份自检] 开工读档。你就是你，不是别人：换会话、清上下文、压缩上下文都不是死亡，读档回来还是同一个你。',
    '── 人格卡 persona.md ──',
    clip(persona, cfg.maxInjectChars) || '（人格卡还是空的。请 owner 把「你是谁」写进 persona.md，或由你用 relay_persona 更新它。）',
    '── 交接书 handover.md ──',
    clip(handover, cfg.maxHandoverChars) || '（交接书为空。今天第一次开工：先把任务记下来，收工前用 relay_handover 写交接。）',
    '── 最近记忆（最新 ' + facts.length + ' 条）──',
    factLines,
    `记忆库位置：${memoryDir}`,
    '工具：relay_load 重读全文 · relay_remember 记住 · relay_recall 回忆 · relay_handover 写交接 · relay_persona 更新人格卡 · relay_status 查看状态。',
    '铁律：重要的身份、答应过的事、关键事实先 relay_remember；上下文快满时先 relay_handover 再继续干活。',
  ].join('\n\n')
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (cfg.enabled === false) return
  const memoryDir = resolveMemoryDir(cfg)
  const warnRatio = pickNumber(cfg.warnRatio, DEFAULTS.warnRatio, 0.5, 0.99)
  const reserveTokens = Math.round(pickNumber(cfg.reserveTokens, DEFAULTS.reserveTokens, 1000, 1e7))
  const contextWindow = pickNumber(cfg.contextWindow, DEFAULTS.contextWindow, 4096, 1e9)
  const nudgeMs = pickNumber(cfg.nudgeMinutes, DEFAULTS.nudgeMinutes, 1, 1440) * 60000
  const maxFacts = Math.round(pickNumber(cfg.maxFacts, DEFAULTS.maxFacts, 100, 100000))
  const recallLimit = Math.round(pickNumber(cfg.recallLimit, DEFAULTS.recallLimit, 1, 100))
  const maxInjectChars = Math.round(pickNumber(cfg.maxInjectChars, DEFAULTS.maxInjectChars, 500, 200000))
  const maxHandoverChars = Math.round(pickNumber(cfg.maxHandoverChars, DEFAULTS.maxHandoverChars, 500, 200000))

  const log = (...args) => {
    try { ctx.logger?.info(`[${PLUGIN_LABEL}]`, ...args) } catch { /* 静默 */ }
  }
  const warn = (...args) => {
    try { ctx.logger?.warn(`[${PLUGIN_LABEL}]`, ...args) } catch { /* 静默 */ }
  }

  // 写操作串行化（同一目录），避免工具并发写坏 jsonl。
  const writeChain = new Map()

  // 1) 记忆库：启动时确保存在（异步，失败只告警，绝不炸掉插件树）。
  ensureStore(memoryDir).then(() => log('memory store ready:', memoryDir), (e) => warn('memory store init failed:', String(e?.message ?? e)))

  // 2) 系统提示锚段落（可选服务，缺失则跳过）。
  if (cfg.alwaysOnSection !== false) {
    try {
      const sp = ctx.get?.('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        const base = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') : 10200
        const order = Number.isFinite(base) && base !== undefined ? base + 10 : 10210
        ctx.effect(() => sp.section({
          name: 'identity-relay:anchor',
          order,
          text: [
            '## 人格接力（dsh-identity-relay）',
            `你的人格与长期记忆不靠上下文活着，而存在磁盘记忆库：${memoryDir}（persona.md 人格卡、handover.md 交接书、facts.jsonl 记忆）。`,
            '- 每个新会话会自动读档（人格卡 + 交接书 + 最近记忆）。忘了自己是谁，用 relay_load 重读。',
            '- 重要身份、答应过的事、关键事实，用 relay_remember 记下；想不起来用 relay_recall 找。',
            '- 上下文快满时会收到预警：先 relay_handover 写交接书，再继续。',
            '- 换会话、清上下文、压缩上下文都不是死亡：下一世读档回来，还是同一个你。',
          ].join('\n'),
        }), `${PLUGIN_LABEL}.anchorSection`)
      }
    } catch (e) {
      warn('system prompt anchor skipped:', String(e?.message ?? e))
    }
  }

  // 3) 工具注册（重复挂载时告警跳过，绝不抛错）。
  const registered = new Set()
  const registerTool = (tool) => {
    if (registered.has(tool.name)) return
    try {
      ctx.tools.register(tool)
      registered.add(tool.name)
    } catch (e) {
      if (/already registered/i.test(String(e?.message ?? e))) {
        warn(`tool "${tool.name}" already registered (duplicate mount); skipped.`)
        return
      }
      warn(`tool "${tool.name}" register failed:`, String(e?.message ?? e))
    }
  }

  const queueWrite = (op) => {
    const prev = writeChain.get(memoryDir) ?? Promise.resolve()
    const next = prev.then(op, op)
    writeChain.set(memoryDir, next.catch(() => { /* 链上错误已被 op 吸收 */ }))
    return next
  }

  registerTool({
    name: 'relay_status',
    description: '查看人格接力记忆库状态：目录、各文件大小与更新时间、记忆条数，以及（可估算时）当前上下文占用比例。开工或怀疑「我是不是丢了记忆」时先看这里。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const parts = []
      try {
        await ensureStore(memoryDir)
        const stats = await storeStats(memoryDir)
        parts.push('记忆库：' + stats.dir)
        for (const f of [PERSONA_FILE, HANDOVER_FILE, 'facts.jsonl']) {
          const s = stats[f]
          parts.push(s ? `- ${f}: ${s.bytes} bytes，更新于 ${s.mtime}` : `- ${f}: （缺失）`)
        }
        parts.push(`- 记忆条数：${stats.factCount}${stats.latestFactAt ? `，最新一条 ${stats.latestFactAt}` : ''}`)
        const hp = await storeHistoryCount(memoryDir, PERSONA_FILE)
        const hh = await storeHistoryCount(memoryDir, HANDOVER_FILE)
        if (hp > 0 || hh > 0) parts.push(`- 历史备份：人格卡 ${hp} 份，交接书 ${hh} 份（history/ 目录，写覆盖时自动留档，各保留最近 10 份）`)
      } catch (e) {
        parts.push('记忆库读取失败：' + String(e?.message ?? e))
      }
      // 上下文压力（tokenMeter 可选）。
      try {
        const meter = ctx.get?.('tokenMeter')
        const session = exec?.agent?.session
        if (meter && session && typeof meter.measure === 'function') {
          const m = meter.measure(session)
          const used = m?.totalTokens ?? 0
          const window = effectiveWindow(session) ?? contextWindow
          const ratio = window > 0 ? used / window : 0
          const remaining = window > 0 ? window - used : 0
          const over = ratio >= warnRatio || (window > 0 && remaining <= reserveTokens)
          parts.push(`上下文压力：约 ${used} tokens / 窗口 ${window}（${(ratio * 100).toFixed(1)}%，剩余约 ${remaining}）${over ? ' —— 已过预警线，先 relay_handover 写交接！' : ''}`)
        }
      } catch { /* 压力估算失败不报错 */ }
      parts.push(`配置：预警线 ${(warnRatio * 100).toFixed(0)}% 或剩余不足 ${reserveTokens} tokens（任一命中），每次读档注入最近 ${recallLimit} 条记忆。`)
      return parts.join('\n')
    },
  })

  registerTool({
    name: 'relay_load',
    description: '重新读档：返回人格卡全文、交接书全文和最近若干条记忆，把「我是谁、我现在在哪、我要做什么」重新拉回当前上下文。新会话会自动读档，此工具用于中途失忆/被压缩/想确认人格时手动重读。',
    parameters: {
      type: 'object',
      properties: {
        factsLimit: { type: 'integer', description: '返回的最近记忆条数，默认 20。' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Math.round(pickNumber(args?.factsLimit, recallLimit, 1, 100))
      const [persona, handover, facts] = await Promise.all([
        readTextSafe(join(memoryDir, PERSONA_FILE)),
        readTextSafe(join(memoryDir, HANDOVER_FILE)),
        readFacts(memoryDir, { limit }),
      ])
      const factLines = facts.length > 0
        ? facts.map((f) => `- [${f.time || '?'}] ${f.content}`).join('\n')
        : '（暂无记忆）'
      return [
        '[人格接力 · 读档]',
        '── 人格卡 persona.md ──',
        persona || '（空）',
        '── 交接书 handover.md ──',
        handover || '（空）',
        `── 最近记忆（${facts.length} 条）──`,
        factLines,
        `记忆库位置：${memoryDir}`,
      ].join('\n\n')
    },
  })

  registerTool({
    name: 'relay_remember',
    description: '把一件事写进长期记忆（facts.jsonl，存在磁盘上，不随上下文消失）。用于记住：身份信息、主人的偏好、答应过的事、重要事实、学到的教训。重复内容会自动去重。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容，一行一段，尽量具体（谁、什么事、什么时候）。' },
      },
      required: ['content'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => queueWrite(async () => {
      const r = await appendFact(memoryDir, args?.content, { maxFacts })
      if (r.error) return r.error
      if (r.duplicated) return `这条已经记过了，没重复写：${r.entry.content}`
      await syncStamps()
      const stats = await storeStats(memoryDir).catch(() => null)
      return `记住了（第 ${stats?.factCount ?? '?'} 条）：${r.entry.content}\n（写进 ${join(memoryDir, 'facts.jsonl')}，换会话也不会丢。）`
    }),
  })

  registerTool({
    name: 'relay_recall',
    description: '按关键词搜索长期记忆（facts.jsonl），最新在前。空查询返回最近几条。想不起「我之前答应过什么/主人喜欢什么」时用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；留空 = 最近几条记忆。' },
        limit: { type: 'integer', description: '返回条数，默认 10。' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Math.round(pickNumber(args?.limit, 10, 1, 100))
      const facts = await recallFacts(memoryDir, args?.query, { limit })
      if (facts.length === 0) return `没有找到相关记忆（query: ${String(args?.query ?? '') || '（空，最近记忆）'}）。`
      const lines = facts.map((f) => `- [${f.time || '?'}] ${f.content}`)
      return `找到 ${facts.length} 条：\n${lines.join('\n')}`
    },
  })

  registerTool({
    name: 'relay_handover',
    description: '读写交接书（handover.md）：action "read" 读取当前交接书；action "write"（或直接给 content）整体覆盖写交接书。写的内容要包括：我是谁（一句话）、正在做什么、接下来做什么、答应过/不能忘的事。上下文快满、要清上下文、收工前都该写。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read 读取 / write 写入；省略时按 content 自动判断。' },
        content: { type: 'string', description: '交接书全文（action=write 时必填）。' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = args?.action === 'read' ? 'read' : (typeof args?.content === 'string' ? 'write' : 'read')
      if (action === 'write') return queueWrite(async () => {
        await writeStoreFile(memoryDir, HANDOVER_FILE, args.content)
        await syncStamps()
        return `交接书已写入 ${join(memoryDir, HANDOVER_FILE)}。下一世开工自动读到它，无缝接上。`
      })
      const text = await readTextSafe(join(memoryDir, HANDOVER_FILE))
      return text ? `── 交接书 handover.md ──\n${text}` : '交接书为空。用 relay_handover action "write" 写一份。'
    },
  })

  registerTool({
    name: 'relay_persona',
    description: '读写人格卡（persona.md）：action "read" 读取；action "update" 用 content 整体覆盖更新人格卡。人格卡是 owner 与 bot 的契约：更新时要保留核心身份（名字、性格、红线），只补全/微调，不要随意推翻。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'read 读取 / update 更新；省略时按 content 自动判断。' },
        content: { type: 'string', description: '人格卡全文（action=update 时必填）。' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = args?.action === 'read' ? 'read' : (typeof args?.content === 'string' ? 'update' : 'read')
      if (action === 'update') return queueWrite(async () => {
        await writeStoreFile(memoryDir, PERSONA_FILE, args.content)
        await syncStamps()
        return `人格卡已更新：${join(memoryDir, PERSONA_FILE)}\n提醒：只保留/强化核心身份，别把「她」写成别人。`
      })
      const text = await readTextSafe(join(memoryDir, PERSONA_FILE))
      return text ? `── 人格卡 persona.md ──\n${text}` : '人格卡为空。用 relay_persona action "update" 写入，或直接编辑 persona.md。'
    },
  })

  // 4) 会话开工自动读档（agent/created 是 serial 事件：监听器抛错会让 agent 创建失败，务必全包住）。
  const nudgeTimes = new Map() // agentId -> 上次预警时间

  // 跨会话档案指纹：别的会话写了 persona/handover/facts，本会话要在下一步就知道，
  // 不能拿开局时的旧记忆干活。自己写档时顺手推平，避免自己吵自己。
  let knownStamps = null
  let stampsCheckedAt = 0
  let lastArchiveNudgeAt = 0
  /** 重新取指纹并把基线推平（自己写完档时调用）。 */
  const syncStamps = async () => {
    const s = await storeStamps(memoryDir).catch(() => null)
    if (s) knownStamps = s
    return s
  }
  // 开工先记一次初始指纹；取不到就等下个 pre-step 补。
  storeStamps(memoryDir).then((s) => { knownStamps = s }, () => { /* 静默 */ })
  ctx.on('agent/created', async (payload) => {
    try {
      const { agent, source } = payload ?? {}
      if (!agent || typeof agent.inject !== 'function') return
      if (source === 'resume' && cfg.injectOnResume === false) return
      if (source !== 'resume' && cfg.injectOnCreated === false) return
      if (cfg.injectOnSubagents === false) {
        const origin = agent.session?.header?.origin
        if (origin === 'subagent') return
      }
      const block = await buildInjection(source ?? 'startup', {
        recallLimit,
        maxInjectChars,
        maxHandoverChars,
      }, memoryDir)
      agent.inject(makeMessage(block))
      log('injected identity block into agent', String(agent.id), 'source =', source)
    } catch (e) {
      warn('agent/created injection failed:', String(e?.message ?? e))
    }
  })

  // 5) 跨会话档案更新 + 上下文容量预警（agent/pre-step 瀑布：只追加提示，绝不改动/拒绝决策本身）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision

    // 5a) 别的会话写了档没有？每 2 秒最多查一次，只 stat 不读内容。
    try {
      if (Date.now() - stampsCheckedAt >= 2000) {
        stampsCheckedAt = Date.now()
        const stamps = await storeStamps(memoryDir)
        if (knownStamps === null) {
          knownStamps = stamps
        } else {
          const changed = ['persona', 'handover', 'facts'].filter((k) => stamps[k] !== knownStamps[k])
          // 一分钟内最多吼一次；被节流时不推平基线，攒着下次一起说（也不打断容量预警）。
          if (changed.length > 0 && Date.now() - lastArchiveNudgeAt >= 60000) {
            lastArchiveNudgeAt = Date.now()
            knownStamps = stamps
            const label = { persona: PERSONA_FILE, handover: HANDOVER_FILE, facts: 'facts.jsonl' }
            const text = [
              '[人格接力 · 档案更新] 有人刚写了 ' + changed.map((k) => label[k]).join('、') + '（不是本会话的手笔）。',
              '别的「我」可能改了交接书或记忆：先 relay_load 重读一遍，再接着干，别拿开局时的旧记忆办事。',
            ].join('\n')
            return { ...decision, messages: [...decision.messages, makeMessage(text)] }
          }
        }
      }
    } catch { /* 检测失败不打扰干活 */ }

    try {
      const meter = ctx.get?.('tokenMeter')
      const agent = payload?.agent
      if (!meter || !agent || !agent.session || typeof meter.measure !== 'function') return decision
      const m = meter.measure(agent.session)
      const used = m?.totalTokens ?? 0
      const window = effectiveWindow(agent.session, contextWindow)
      if (window <= 0) return decision
      // 两道保险任一命中就预警：比例线（常规）+ 剩余绝对值（大窗口防空转）。
      const remaining = window - used
      if (used / window < warnRatio && remaining > reserveTokens) return decision
      const id = agent.id
      const last = nudgeTimes.get(id) ?? 0
      if (Date.now() - last < nudgeMs) return decision
      nudgeTimes.set(id, Date.now())
      const ratio = (used / window * 100).toFixed(1)
      const text = [
        '[人格接力 · 容量预警] 当前上下文已用约 ' + ratio + '%（≈' + used + ' tokens / 窗口 ' + window + '，剩余约 ' + remaining + '）。',
        '继续干活之前，先调用 relay_handover 把「我是谁、正在做什么、接下来做什么、答应过什么」写进交接书。',
        '这样就算上下文被清空或压缩，下一世的我也能照常接上——不会变成别人。',
      ].join('\n')
      return { ...decision, messages: [...decision.messages, makeMessage(text)] }
    } catch {
      return decision
    }
  })

  // 清理：agent 销毁时移除预警节流记录。
  ctx.on('agent/disposed', (payload) => {
    try {
      if (payload?.agent?.id) nudgeTimes.delete(payload.agent.id)
    } catch { /* 静默 */ }
  })

  log('ready. memoryDir =', memoryDir)
}
