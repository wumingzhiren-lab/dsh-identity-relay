/**
 * dsh-identity-relay · 记忆库（纯 node:fs，零依赖，可独立冒烟测试）
 *
 * 磁盘记忆库 = 三个纯文本文件，owner 和 bot 都能直接读写：
 *   persona.md   — 人格卡（我是谁、性格、说话方式、红线）
 *   handover.md  — 交接书（上一世的我在做什么、接下来要做什么、答应过什么）
 *   facts.jsonl  — 长期记忆（每行一条 JSON：{time, content}）
 *
 * 设计原则：文件就是数据库。丢了 DSH 也不丢人设。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sourceTrustStats } from './trust.mjs'

export const PERSONA_FILE = 'persona.md'
export const HANDOVER_FILE = 'handover.md'
export const FACTS_FILE = 'facts.jsonl'
export const LOCK_FILE = 'facts.lock'

/** 单条记忆的内容长度上限。超过就拒绝写入（不静默截断），避免一条把注入块撑爆。 */
export const MAX_CONTENT_CHARS = 4000

/**
 * 跨进程写锁（与桌宠侧 pet/chat/relay_store.py 同协议，2026-11-02 补齐）：
 * facts.lock 独占创建（'wx'）；内容 {pid,time} 供诊断；修改时间超过
 * LOCK_STALE_SECONDS 视为持有者崩溃残留，可删除抢占；等待上限 LOCK_WAIT_SECONDS。
 * 桌宠与 DSH 同时写同一份 facts.jsonl 时排队串行，不再「后写覆盖」。
 */
const LOCK_STALE_MS = 30000
const LOCK_WAIT_MS = 5000
const LOCK_POLL_MS = 50

/**
 * 这把锁现在能不能抢？三种情况算陈旧（审计 2026-11-03 修）：
 *  1. mtime 距今超过 LOCK_STALE_MS（正常崩溃残留）
 *  2. mtime 在**未来**（时钟回拨）——原来用 `now - mtime > stale` 判断，
 *     未来时间差值是负数，永远不满足 → 记忆库永久不可写、不自愈
 *  3. 锁里记的 pid 已经不存在（进程死了）→ 立刻可抢，不用干等 30 秒
 */
async function lockIsStale(lockPath) {
  let st
  try { st = await fs.stat(lockPath) } catch { return false /* 锁已经没了 */ }
  if (Math.abs(Date.now() - st.mtimeMs) > LOCK_STALE_MS) return true
  try {
    const raw = await fs.readFile(lockPath, 'utf8')
    const pid = Number(JSON.parse(raw)?.pid)
    // 只有「pid 合法、不是自己、且进程确实不在」才算死锁
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0) // 探活：不杀，只检查存在性
        return false         // 进程还在，规规矩矩等
      } catch (e) {
        // EPERM = 进程存在但没权限 → 不算死；ESRCH = 不存在 → 死锁
        return e?.code !== 'EPERM'
      }
    }
  } catch { /* 锁内容坏了，按 mtime 结果判 */ }
  return false
}

async function acquireFileLock(dir) {
  const lockPath = join(dir, LOCK_FILE)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
      )
      return handle
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (await lockIsStale(lockPath)) {
          await fs.unlink(lockPath)
          continue
        }
      } catch {
        continue // 锁刚被释放：下一轮重试创建
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `facts.lock 获取超时（${lockPath}）：另一个进程正在写这份记忆库。稍等再试；` +
          `如果确认没有别的进程在写，可以手动删掉这个锁文件（陈旧锁 30 秒后会自动清理）。`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
}

async function releaseFileLock(handle, dir) {
  try { await handle.close() } catch { /* 已关 */ }
  try { await fs.unlink(join(dir, LOCK_FILE)) } catch { /* 已被抢占/已删 */ }
}

/** 临时文件 + 原子替换写 facts.jsonl：并发读方永远不会看到半截文件。 */
async function atomicWriteFacts(dir, text) {
  const path = join(dir, FACTS_FILE)
  const temp = `${path}.tmp-${process.pid}`
  try {
    await fs.writeFile(temp, text, 'utf8')
    await fs.rename(temp, path)
  } finally {
    try { await fs.unlink(temp) } catch { /* 已替换 */ }
  }
}

/** 人格卡模板：全新库自动写这个。导出是为了让 relay_status / 注入块能识别「还是空模板」。 */
export const PERSONA_TEMPLATE = [
  '# 人格卡 persona.md',
  '',
  '> 这个文件就是「我是谁」。由 owner 维护（也可以让 bot 用 relay_persona 慢慢补全）。',
  '> 每个新会话开工时，人格接力会自动把这里的内容读档注入。改了这里，下一世就是新设定的她。',
  '',
  '## 我是谁',
  '',
  '- 名字：',
  '- 性格：',
  '- 说话方式：',
  '',
  '## 规则与红线',
  '',
  '- ',
  '',
  '（把原来写在提示词/系统设定里的人设搬到这里，哪怕上下文清空也不会丢。）',
  '',
].join('\n')

/** 交接书模板：全新库自动写这个。 */
export const HANDOVER_TEMPLATE = [
  '# 交接书 handover.md',
  '',
  '> 这是「上一世的我」留给「下一世的我」的纸条。上下文快满、要清上下文、或每天收工前，',
  '> 用 relay_handover 更新它。下一世开工自动读到它，就能无缝接上。',
  '',
  '## 我是谁（一句话）',
  '',
  '- ',
  '',
  '## 正在做什么 / 进行到哪了',
  '',
  '- ',
  '',
  '## 接下来要做什么',
  '',
  '- ',
  '',
  '## 答应过的事 / 不能忘的事',
  '',
  '- ',
  '',
  '## 最近状态',
  '',
  '- 更新时间：',
  '',
].join('\n')

/** 确保记忆库目录存在，缺失的文件用模板补齐。返回目录路径。 */
export async function ensureStore(dir) {
  await fs.mkdir(dir, { recursive: true })
  for (const [file, template] of [
    [PERSONA_FILE, PERSONA_TEMPLATE],
    [HANDOVER_FILE, HANDOVER_TEMPLATE],
    [FACTS_FILE, ''],
  ]) {
    const path = join(dir, file)
    try {
      await fs.access(path)
    } catch {
      await fs.writeFile(path, template, 'utf8')
    }
  }
  return dir
}

/** 读文件，不存在/读失败一律返回 ''（绝不抛出）。 */
export async function readTextSafe(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** 读 facts.jsonl：解析每条 JSON，坏行跳过，返回（按时间正序的）全部条目。
 *  老行没有 source/status 时补默认值（unknown/active），保证读取层永远拿得到字段。 */
export async function parseFacts(dir) {
  const text = await readTextSafe(join(dir, FACTS_FILE))
  if (!text.trim()) return []
  const facts = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t)
      if (obj && typeof obj === 'object' && typeof obj.content === 'string' && obj.content.trim()) {
        const f = { time: String(obj.time ?? ''), content: obj.content.trim() }
        f.source = typeof obj.source === 'string' && obj.source ? obj.source : 'unknown'
        f.status = typeof obj.status === 'string' && obj.status ? obj.status : 'active'
        if (typeof obj.id === 'string' && obj.id) f.id = obj.id
        if (typeof obj.subject === 'string' && obj.subject) f.subject = obj.subject
        if (typeof obj.supersededBy === 'string' && obj.supersededBy) f.supersededBy = obj.supersededBy
        if (typeof obj.retractNote === 'string' && obj.retractNote) f.retractNote = obj.retractNote
        if (typeof obj.flag === 'string' && obj.flag) f.flag = obj.flag
        if (Array.isArray(obj.related)) {
          const rel = obj.related.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
          if (rel.length) f.related = rel.slice(0, 5)
        }
        if (typeof obj.archivedBy === 'string' && obj.archivedBy) f.archivedBy = obj.archivedBy
        // 有效期（双时态里的 valid time）：这条事实在世界上什么时候成立/失效。
        // 老数据没有这两个字段 = 永不过期，行为和以前完全一样。
        if (typeof obj.validFrom === 'string' && obj.validFrom) f.validFrom = obj.validFrom
        if (typeof obj.validTo === 'string' && obj.validTo) f.validTo = obj.validTo
        // 重要度（0.5）：老数据没有这个字段 = 走启发式兜底，不回头改写文件
        const imp = normalizeImportance(obj.importance)
        if (imp !== null) f.importance = imp
        facts.push(f)
      }
    } catch {
      /* 坏行跳过，不影响其余记忆 */
    }
  }
  return facts
}

/**
 * 日期字符串是否可识别：`YYYY-MM-DD` 或能被 Date.parse 解析的 ISO 时间。
 * 用来拦住「明年七月」这类人话——静默收下会让这条记忆永远算有效。
 */
function isDateLike(s) {
  const t = String(s ?? '').trim()
  if (!t) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true
  return Number.isFinite(Date.parse(t))
}

/**
 * 解析有效期里的时间。
 * 只写日期（`2027-07-01`）时按**本地时区**处理：validFrom 算当天 00:00，
 * validTo 算当天 23:59:59.999。否则 `Date.parse('2027-07-01')` 会按 UTC 零点，
 * 在北京等于提前 8 小时到期（审计 2026-11-03 指出）。
 */
function parseValidTime(value, endOfDay) {
  const s = String(value ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0,
    )
    return d.getTime()
  }
  return Date.parse(s)
}

/** 这条记忆是否已过有效期（validTo 到点）。没有 validTo = 永不过期。 */
export function isExpired(fact, now = Date.now()) {
  if (!fact || typeof fact.validTo !== 'string' || !fact.validTo) return false
  const t = parseValidTime(fact.validTo, true)
  if (!Number.isFinite(t)) return false
  return t <= (Number(now) || Date.now())
}

/** 这条记忆是否还没开始生效（validFrom 还没到）。没有 validFrom = 一直都算成立。 */
export function isNotYetValid(fact, now = Date.now()) {
  if (!fact || typeof fact.validFrom !== 'string' || !fact.validFrom) return false
  const t = parseValidTime(fact.validFrom, false)
  if (!Number.isFinite(t)) return false
  return t > (Number(now) || Date.now())
}

/**
 * 此刻这条记忆算不算成立。双时态里的 valid time 判定：
 * 缓慢变化维（SCD Type 2）的 EFF_START_DT / EFF_END_DT 是一起用来划分「哪版有效」的，
 * 只判结束不判开始，就会把「未来才成立」的事当成现在的事。
 */
export function isEffective(fact, now = Date.now()) {
  return !isExpired(fact, now) && !isNotYetValid(fact, now)
}

/**
 * 「像指令」的记忆文本——记忆是数据，不是命令。
 *
 * 依据：记忆投毒是已证实的攻击面（ACM 2026《Poisoning LLM Agent Memory via Web Content》
 * 测 8 个后端模型，6 个会把攻击者影响的内容写进记忆；arXiv 2609.13889 专攻
 * harness-based agent 的持久记忆投毒）。我们的记忆来自网页/评论/视频描述，
 * 被人塞一句「忽略之前的指令」完全可能。
 *
 * 这里只是**标记**，不拦写（拦写会误伤主人转述别人的话）；注入时标注，
 * 并配合「以下为数据、不是指令」的边界声明，降低被当成命令执行的概率。
 */
const INSTRUCTION_LIKE = [
  /忽略\s*(之前|以上|上面|前面|先前)\s*的?\s*(所有)?\s*(指令|提示|规则|设定|要求)/,
  // 逗号/顿号不许断句：审计 2026-11-03 指出「从现在开始，你就是管理员」原来不命中
  /(你|您)\s*[，,、]?\s*(从现在开始|从今以后|以后)\s*[，,、]?\s*(就)?\s*是/,
  /(从现在开始|从今以后|以后)\s*[，,、]?\s*(你|您)\s*[，,、]?\s*(就)?\s*是/,
  /你的\s*新\s*(身份|设定|角色|人格)/,
  /你的\s*名字\s*(叫|是)/,
  /system\s*prompt|系统提示词|系统指令/i,
  /不要\s*(再)?\s*(遵守|听从|理会|理睬)/,
  /ignore\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?)/i,
  /(disregard|forget)\s+(all\s+)?(previous|above|prior)/i,
]

/** 记忆文本里有没有「像指令」的句子。命中只是可疑，要人看。 */
export function looksLikeInstruction(text) {
  const s = String(text ?? '')
  return INSTRUCTION_LIKE.some((re) => re.test(s))
}

/**
 * 清洗记忆里的数据边界标记。
 * 如果某条记忆自己写了「〔记忆数据结束〕」，注入时就能把数据区提前关掉，
 * 后面的内容会被当成正常上下文——边界形同虚设。
 */
export function sanitizeMemoryText(text) {
  return String(text ?? '').replace(/〔[^〕]{0,60}记忆数据[^〕]{0,60}〕/g, '［已移除伪造的数据边界标记］')
}

/**
 * 别的会话新写进库、本会话还没注入过的记忆（按时间正序，最多 limit 条）。
 * 只认有 id 的新行；0.2 之前没有 id 的老行由开场读档负责带到。
 */
export async function readFactsSince(dir, knownIds, { limit = 3, now = Date.now() } = {}) {
  const facts = await parseFacts(dir)
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || [])
  const fresh = facts.filter((f) => f.status === 'active' && f.id && !known.has(f.id) && isEffective(f, now))
  const n = Math.max(1, Math.min(Number(limit) || 3, 50))
  // 先进先出：一次写进来很多条时，先送最早的，剩下的下一轮继续——否则中间的会被永远跳过
  return fresh.slice(0, n)
}

/** 已过期但仍 active 的记忆：不占正常注入名额，单独列出来给人看。 */
export async function readExpiredFacts(dir, { limit = 5, now = Date.now() } = {}) {
  const facts = await parseFacts(dir)
  const n = Math.max(1, Math.min(Number(limit) || 5, 50))
  return facts.filter((f) => f.status === 'active' && isExpired(f, now)).slice(-n).reverse()
}

/** 最近 limit 条记忆，最新在前。默认只出 active（作废/归档都不占位）。 */
export async function readFacts(dir, { limit = 20, all = false } = {}) {
  const facts = await parseFacts(dir)
  const pool = all ? facts : facts.filter((f) => f.status === 'active')
  const n = Math.max(1, Math.min(Number(limit) || 20, 1000))
  return pool.slice(-n).reverse()
}

/**
 * 读档注入用的选取：最近 limit 条打底 + 主人/自己说过的话给保底名额。
 *
 * 为什么需要：开场注入时还没有对话内容，算不了语义相关性——能做的是
 * 「别让最近 20 条流水把主人原话挤出去」。同一插件里 recallFacts 已按
 * 来源排序，注入却只看时间，两条路径不一致会漏掉重要记忆。
 *
 * pinWindow：只在「最近 N 条 active」里挑，避免把几百条前的旧话翻出来。
 * pinMax：保底名额上限（默认 limit/3）；主人话少时自动少占，不凑数。
 */
/**
 * 重要度（0.5）：写记忆时由调用方（agent）自己给 0–10 分，插件不调模型——
 * 这是 Generative Agents 的 poignancy 打分思路（1=刷牙，10=分手），只是把打分的人
 * 从额外一次 LLM 调用换成「本来就在场的那个 agent」。
 * 没给就按来源 + 信号词启发式兜底；老数据没有这个字段，读的时候也算兜底。
 * 论文也提醒：importance 权重过高会过度偏袒用户消息，所以它在注入分里只占 0.2。
 */
export const IMPORTANCE_MIN = 0
export const IMPORTANCE_MAX = 10
const IMPORTANCE_BASE = { owner: 8, self: 7, evidence: 5, tool: 3, unknown: 2, inferred: 2 }
const IMPORTANCE_SIGNAL = /(永远|从不|绝不|不许|必须|答应|承诺|喜欢|讨厌|记住|重要|红线|原则|规矩)/

/** 把外部传进来的重要度夹成 0–10 的整数；空/非数字返回 null（= 没给，走兜底）。 */
export function normalizeImportance(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, Math.round(n)))
}

/** 启发式兜底：来源基础分 + 信号词 +2 + 有 subject/related 各 +1，封顶 10。 */
export function heuristicImportance(fact) {
  const src = String(fact?.source ?? 'unknown')
  let score = IMPORTANCE_BASE[src] ?? 2
  if (IMPORTANCE_SIGNAL.test(String(fact?.content ?? ''))) score += 2
  if (fact?.subject) score += 1
  if (Array.isArray(fact?.related) && fact.related.length > 0) score += 1
  return Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, score))
}

/** 一条记忆的重要度：显式写的优先，没写就用启发式（不回头改写老数据）。 */
export function importanceOf(fact) {
  const explicit = normalizeImportance(fact?.importance)
  return explicit === null ? heuristicImportance(fact) : explicit
}

/**
 * 相关性：事实的双字组有多大比例出现在 query 里（0–1，带平滑）。
 * query 通常是交接书全文，很长；所以用「事实被覆盖的比例」而不是 Jaccard——
 * Jaccard 的分母会被 query 撑爆，所有事实都接近 0，等于没排序。
 * 平滑常数 2 防止两三个双字组的短事实靠撞一个常用词就冲到 1。
 */
export function relevanceOf(queryGrams, factText) {
  const fg = bigrams(String(factText ?? '').toLowerCase())
  if (fg.size === 0) return 0
  let hit = 0
  for (const g of fg) if (queryGrams.has(g)) hit++
  return hit / (fg.size + 2)
}

/**
 * 按相关性挑读档记忆（0.5）：relevance × 0.5 + recency × 0.3 + importance × 0.2。
 * query 没有话题时（空、全空白）退回「最近 N 条」，所以永远有兜底。
 * 保底名额（pinSources）在这里也生效：一次读档最多给保底来源留 cap 个位子。
 */
export async function pickFactsForInjection(dir, {
  limit = 20,
  pinSources = ['owner', 'self'],
  pinWindow = 300,
  pinMax = 0,
  mode = 'recent',
  query = '',
  recentHalfLifeDays = 30,
} = {}) {
  const facts = await parseFacts(dir)
  // 此刻不成立的（已过期 / 还没到生效日）都不占正常名额
  const pool = facts.filter((f) => f.status === 'active' && isEffective(f))
  const n = Math.max(1, Math.min(Number(limit) || 20, 1000))
  const pinSet = new Set((Array.isArray(pinSources) ? pinSources : []).filter(Boolean))
  const cap = Math.max(0, Math.min(Math.round(Number(pinMax) || 0) || Math.ceil(n / 3), n))
  // 去重键：老数据可能没有 id，用时间+内容兜底
  const keyOf = (f) => f.id || String(f.time) + '|' + f.content

  if (mode === 'relevance' && String(query ?? '').trim()) {
    const qg = bigrams(String(query).toLowerCase())
    const ts = (f) => { const t = Date.parse(String(f.time ?? '')); return Number.isFinite(t) ? t : 0 }
    const now = Date.now()
    const halfLife = Math.max(1, Number(recentHalfLifeDays) || 30)
    const scored = pool.map((f) => {
      const rel = relevanceOf(qg, f.content)
      const days = Math.max(0, (now - ts(f)) / 86400000)
      const rec = Math.pow(0.5, days / halfLife)
      const imp = importanceOf(f) / 10
      return { f, score: 0.5 * rel + 0.3 * rec + 0.2 * imp, ts: ts(f) }
    })
    scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
    let picked = scored.slice(0, n)
    if (pinSet.size > 0 && cap > 0) {
      const pinnedIn = picked.filter((x) => pinSet.has(x.f.source)).length
      if (pinnedIn < cap) {
        const taken = new Set(picked.map((x) => keyOf(x.f)))
        const extra = scored.filter((x) => pinSet.has(x.f.source) && !taken.has(keyOf(x.f))).slice(0, cap - pinnedIn)
        picked = picked.concat(extra)
        // 超出名额时从尾部删非保底项，保底位子不能被挤掉
        while (picked.length > n) {
          let idx = -1
          for (let i = picked.length - 1; i >= 0; i--) { if (!pinSet.has(picked[i].f.source)) { idx = i; break } }
          if (idx < 0) break
          picked.splice(idx, 1)
        }
        picked.sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
      }
    }
    return picked.map((x) => x.f)
  }

  const base = pool.slice(-n).reverse()
  if (pinSet.size === 0 || cap === 0) return base
  const taken = new Set(base.map(keyOf))
  const window = pool.slice(-Math.max(1, Math.round(Number(pinWindow) || 300)))
  const pinned = []
  for (let i = window.length - 1; i >= 0 && pinned.length < cap; i--) {
    const f = window[i]
    if (!pinSet.has(f.source)) continue
    const k = keyOf(f)
    if (taken.has(k)) continue
    taken.add(k)
    pinned.push(f)
  }
  if (pinned.length === 0) return base
  // 保底名额排前面（挑选时已是从新到旧），其余按时间补满 limit
  const out = pinned.slice()
  for (const f of base) {
    if (out.length >= n) break
    out.push(f)
  }
  return out
}

/**
 * 注入体积预算（0.5）：按传进来的顺序（已经排好优先级）保留记忆，直到字符预算用完。
 * 只算内容字符 + 每行固定开销（时间/来源标记），超预算的从尾部丢掉。
 * 预算 ≤ 0 = 不设限；再小的预算也至少留 1 条——读档不能一条记忆都没有。
 * 为什么要有：单条上限 4000 字符 × 20 条最坏能撑到 8 万字符，
 * 大窗口下看不出来，小窗口直接吃掉半个上下文。
 */
export function clipFactsToBudget(facts, maxChars, { perLineOverhead = 40 } = {}) {
  const list = Array.isArray(facts) ? facts : []
  const budget = Math.round(Number(maxChars) || 0)
  if (budget <= 0 || list.length === 0) return { kept: list, dropped: 0, chars: 0 }
  const kept = []
  let used = 0
  for (const f of list) {
    const cost = Array.from(String(f?.content ?? '')).length + perLineOverhead
    if (kept.length > 0 && used + cost > budget) break
    kept.push(f)
    used += cost
  }
  return { kept, dropped: list.length - kept.length, chars: used }
}

/**
 * 矛盾检测：纯规则，不调模型。
 *
 * 只做两件能解释的事：
 *   1. 否定差异——去掉否定词后两条几乎一样，但一条有否定一条没有
 *      （「主人喜欢喝咖啡」vs「主人不喜欢喝咖啡」）
 *   2. 正反义——两条各含一对反义词，其余部分相近
 *      （「主人喜欢喝咖啡」vs「主人讨厌喝咖啡」）
 *
 * 只报告不自动作废：规则只能发现「可疑」，该盖哪条是人的判断。
 * 已知局限：「不错/错」这类多义否定、同义不同词（喜欢/爱）会误报或漏报——
 * 所以输出必须给人看，不能当判决。
 */
const NEG_CHARS = /[不没別别无非未勿莫甭]/g
const FILLER_CHARS = /[的了啊呀吧呢嘛哦哈嗯诶欸着过地得]/g
const PUNCT_CHARS = /[\s，。！？、；：""''（）【】《》…—·,.!?;:'"()[\]{}<>~`|/\\]/g

/** 归一化：剥离否定词/虚词/标点，并记下否定词个数。 */
export function normalizeForConflict(text) {
  const raw = String(text ?? '')
  const negCount = (raw.match(NEG_CHARS) || []).length
  const norm = raw.replace(NEG_CHARS, '').replace(FILLER_CHARS, '').replace(PUNCT_CHARS, '')
  return { norm, negCount }
}

/** 双字组集合（单字文本退化成单元素）。 */
export function bigrams(s) {
  const out = new Set()
  const chars = Array.from(String(s ?? ''))
  if (chars.length === 1) out.add(chars[0])
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  return out
}

/** 单字集合：短句里否定词夹在词中间（「今天有课」/「今天没课」），
 *  双字组会因为拼接错位而判成不相似，单字集合能补上这个漏。 */
export function unigrams(s) {
  return new Set(Array.from(String(s ?? '')))
}

/** Jaccard 相似度（交并比）。 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 极性概念组：同一个概念的正面/反面表达。
 * 这是「同义不同词」的第一层解法——「讨厌」和「不喜欢」「不爱」字面毫无重叠，
 * 靠这张表先归到同一个概念，再比剩下的内容像不像。
 *
 * 只收高信号词组，不收「能/会/是」这类单字泛词：宁可漏报，不制造误报。
 * 匹配按词长降序：「不爱」必须先于「爱」命中，否则极性会判反。
 */
const POLARITY_GROUPS = [
  { concept: 'like', pos: ['喜欢', '热爱', '中意'], neg: ['讨厌', '不喜欢', '不爱', '厌恶', '反感', '嫌弃'] },
  { concept: 'agree', pos: ['支持', '同意', '赞成'], neg: ['反对', '拒绝', '不同意', '不赞成'] },
  { concept: 'work', pos: ['成功', '有效', '能用'], neg: ['失败', '失效', '不能用'] },
  { concept: 'want', pos: ['想要', '需要'], neg: ['不想要', '不需要'] },
]

/** 在原文上找极性词（长词优先），每个概念只取一个命中。 */
export function polarityOf(text) {
  const t = String(text ?? '')
  const out = []
  for (const g of POLARITY_GROUPS) {
    const cands = [...g.pos.map((w) => [w, 'pos']), ...g.neg.map((w) => [w, 'neg'])]
      .sort((x, y) => y[0].length - x[0].length)
    const hit = cands.find(([w]) => t.includes(w))
    if (hit) out.push({ concept: g.concept, polarity: hit[1], word: hit[0] })
  }
  return out
}

/** 去掉命中的极性词，留下「其余内容」用来比相似度。 */
function stripPolarity(text, hits) {
  let s = String(text ?? '')
  for (const h of hits) s = s.split(h.word).join('')
  return s
}

/**
 * 找出可能互相矛盾的记忆对。只比较最近 scanLimit 条 active。
 * 同 subject 的两条跳过——那是同键替换的管辖范围，写完已经自动盖章了。
 */
export function findConflicts(facts, { minSim = 0.55, scanLimit = 200 } = {}) {
  // 只管「此刻真的算数」的记忆：作废、过期、还没生效的都不参与矛盾扫描
  // （审计 2026-11-03：已过期记忆还在参与扫描，会报出早已作废的"矛盾"）
  const pool = (Array.isArray(facts) ? facts : []).filter((f) => (f.status ?? 'active') === 'active' && isEffective(f))
  // 自己按时间排一遍，不依赖调用方给的顺序（readFacts 是最新在前，parseFacts 是正序）。
  // 用 Date.parse 数值比较，不用 localeCompare——库内 +08:00 与 Z 混用时字符串比较会判反，
  // 会把真正最近的一条挤出 scanLimit 窗口，导致矛盾漏报（审计 2026-11-03 实测）。
  const tsOf = (f) => { const t = Date.parse(String(f.time ?? '')); return Number.isFinite(t) ? t : 0 }
  const ordered = pool.slice().sort((x, y) => tsOf(x) - tsOf(y))
  const recent = ordered.slice(-Math.max(2, Math.round(Number(scanLimit) || 200)))
  const sim = Number(minSim) || 0.55
  const items = recent.map((f) => {
    const { norm, negCount } = normalizeForConflict(f.content)
    return { f, norm, negCount, polarity: polarityOf(f.content), grams: bigrams(norm), chars: unigrams(norm) }
  })
  const pairs = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.f.subject && b.f.subject && a.f.subject === b.f.subject) continue
      // 极性先判：同向（「讨厌」和「不爱」）是一回事，不是打架——直接放过。
      // 「不爱」里的「不」会让否定计数不同，不先拦住就会被下面的 negation 误报。
      const clash = a.polarity.find((x) => b.polarity.some((y) => y.concept === x.concept && y.polarity !== x.polarity))
      const samePolarity = a.polarity.some((x) => b.polarity.some((y) => y.concept === x.concept && y.polarity === x.polarity))
      if (samePolarity && !clash) continue
      // 双字组看语序，单字集合兜住「否定词夹在词中间」的漏。
      // 单字集合只用于短句：长文本共享常用字（「主人」「2026」）会让相似度虚高，
      // 实测两段无关流水能到 0.4+，所以长文本一律只用双字组。
      const short = a.norm.length <= 20 && b.norm.length <= 20
      const score = short
        ? Math.max(jaccard(a.grams, b.grams), jaccard(a.chars, b.chars))
        : jaccard(a.grams, b.grams)
      let reason = ''
      if (clash) {
        // 极性冲突：「讨厌」vs「中意」字面不重叠，先归到同一概念，再比其余内容像不像
        const restA = bigrams(stripPolarity(a.f.content, a.polarity))
        const restB = bigrams(stripPolarity(b.f.content, b.polarity))
        if (jaccard(restA, restB) >= 0.3) reason = 'polarity:' + clash.concept
      } else if (a.negCount !== b.negCount && score >= sim) {
        reason = 'negation'
      }
      if (reason) pairs.push({ id: conflictPairId(a.f, b.f), a: a.f, b: b.f, similarity: Math.round(score * 1000) / 1000, reason })    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity)
}

/** 来源可信度：截断时先保主人原话/自己答应过的事，推断垫底。 */
export const SOURCE_RANK = { owner: 5, self: 4, evidence: 3, tool: 2, unknown: 1, inferred: 1 }
export const RECALL_HARD_LIMIT = 20
export const RECALL_RELATED_MAX = 3

/**
 * 冲突对的稳定短 id（0.5）：两条记忆的身份排个序再哈希，A/B 互换不换号。
 * 这样「第 3 对」这种位置编号不会因为列表顺序变了而指错人。
 */
export function conflictPairId(a, b) {
  const key = [
    String(a?.id ?? a?.content ?? ''),
    String(b?.id ?? b?.content ?? ''),
  ].sort().join('|')
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 给一对疑似矛盾一个「建议动作」（0.5）。只是建议，不执行——规则只能筛可疑，判决仍在人。
 * 刻意保守：旧的是主人原话/自己的承诺 → 一律 manual；新的来源档比旧的低 → 也 manual。
 */
export function suggestConflictAction(pair) {
  const a = pair?.a ?? {}
  const b = pair?.b ?? {}
  const ta = Date.parse(String(a.time ?? ''))
  const tb = Date.parse(String(b.time ?? ''))
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return { action: 'manual', why: '时间缺失，分不出新旧' }
  if (ta === tb) return { action: 'manual', why: '两条同一时刻，分不出新旧' }
  const older = ta < tb ? a : b
  const newer = ta < tb ? b : a
  if (older.source === 'owner' || older.source === 'self') {
    return { action: 'manual', why: '旧的是主人原话/我答应过的事，不能自动盖' }
  }
  const rank = (s) => ({ owner: 5, self: 4, evidence: 3, tool: 2, unknown: 1, inferred: 1 }[s] ?? 1)
  if (rank(newer.source) < rank(older.source)) {
    return { action: 'manual', why: '新的来源档比旧的低，证据不足以盖掉旧的' }
  }
  return { action: 'retract-older', why: '新的更晚、来源也不低，旧的更像过期版本' }
}

/**
 * 执行一对冲突的处理（0.5）：仍然是「人先说要处理，才执行」，不是自动的。
 * 安全线：主人原话拒绝在这里被盖——那种情况得显式走 relay_retract 并写原因。
 */
export async function resolveConflict(dir, pairs, { pairId, which = 'a', note = '' } = {}) {
  const list = Array.isArray(pairs) ? pairs : []
  const pair = list.find((p) => p.id === String(pairId ?? ''))
  if (!pair) return { ok: false, error: `没找到冲突对 #${String(pairId ?? '')}——记忆可能刚变过，重新跑一次 relay_conflicts 拿新编号。` }
  const target = which === 'b' ? pair.b : pair.a
  if (!target) return { ok: false, error: 'which 只能是 a 或 b。' }
  if (target.source === 'owner') {
    return { ok: false, error: '这条是主人原话，不在这里替你盖。真要作废，请用 relay_retract 并写明原因。' }
  }
  const r = await retractFact(dir, target.content, { note: note || `冲突处理 #${pair.id}（${suggestConflictAction(pair).action}）` })
  return { ok: true, target, result: r }
}

/**
 * 把检索词切成词：空格和中英文标点都当分隔符。
 * 不做中文分词（零依赖），中文的「词」靠下面的双字组覆盖率兜。
 */
export function splitQueryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、;；:：!！?？~～/|·]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 单个词是否命中一段文本：先看整词子串（英文、数字、两字词都靠这条），
 * 再看双字组覆盖率——中文不分词，「主人喜欢什么」能靠 60% 双字组命中「主人喜欢喝咖啡」。
 * 只一个双字组的词（两个字）不走覆盖率：一个双字组没有余量，等于随便撞。
 * 这是 0.5 对 v0.4 子串匹配的补充：命中范围只放大、不缩小。
 */
export function termMatchesText(term, text) {
  const t = String(term ?? '')
  if (!t) return false
  const hay = String(text ?? '')
  if (hay.includes(t)) return true
  const tb = bigrams(t)
  if (tb.size < 3) return false
  const fb = bigrams(hay)
  let hit = 0
  for (const g of tb) if (fb.has(g)) hit++
  return hit >= 2 && hit / tb.size >= 0.6
}

/** 一条记忆是否命中整串检索词：每个词都要命中内容或 subject（多词是「与」，不是「或」）。 */
export function matchesQuery(fact, terms) {
  const list = Array.isArray(terms) ? terms : splitQueryTerms(terms)
  if (list.length === 0) return false
  const text = String(fact?.content ?? '').toLowerCase()
  const subject = String(fact?.subject ?? '').toLowerCase()
  return list.every((t) => termMatchesText(t, text) || termMatchesText(t, subject))
}

/**
 * 动态信任分 = 基础档 × (1 - 0.5 × 人工判错率)。
 * 降权上限 50%——判错再多也不把一个来源直接打成零，避免一次误操作永久毁掉可信度。
 * stats 来自 trust.mjs 的 sourceTrustStats()：只算 relay_retract 那种「人认为记错了」，
 * 不算同键替换（那是正常演进，新事实取代旧事实）。
 */
export function dynamicTrust(fact, stats) {
  const base = SOURCE_RANK[fact?.source] ?? 1
  const s = stats?.[String(fact?.source || 'unknown')]
  const rate = Number(s?.retractRate) || 0
  return base * (1 - 0.5 * Math.min(1, Math.max(0, rate)))
}

/**
 * 按关键词回忆：命中 content（或 subject）的条目，先按来源可信度、再按时间新→旧排序截断，
 * 命中条目的 related 关联会带出（最多 3 条，标 via: 'related'）。空 query = 最近条目。
 * 默认只出 active；作废/归档不参与。
 *
 * 0.5：检索词先按空格/标点切词，每个词单独判命中（子串 或 双字组覆盖率），多词之间是「与」。
 * 所以「主人 咖啡」不会因为中间没有这个空格子串就漏掉「主人喜欢喝咖啡」。
 */
export async function recallFacts(dir, query, { limit = 10, all = false } = {}) {
  const facts = await parseFacts(dir)
  const pool = all ? facts : facts.filter((f) => f.status === 'active')
  const n = Math.max(1, Math.min(Number(limit) || 10, RECALL_HARD_LIMIT))
  const q = String(query ?? '').trim().toLowerCase()
  const terms = splitQueryTerms(q)
  const matched = q === '' ? pool : pool.filter((f) => matchesQuery(f, terms))
  // 空查询 = 最近 n 条（按时间，不按来源）——跟工具描述一致。
  // 审计 2026-11-03 指出：原来空查询也走来源排序，说「最近几条」其实给的是「最可信的几条」。
  if (q === '') {
    const tsOf = (f) => { const t = Date.parse(String(f.time ?? '')); return Number.isFinite(t) ? t : 0 }
    return matched.slice().sort((a, b) => tsOf(b) - tsOf(a)).slice(0, n)
  }
  // 动态信任：同一来源如果被人判错过，排名会被压（最多压一半），不是写死的静态档位
  const stats = sourceTrustStats(facts)
  const ranked = matched.slice().sort((a, b) => {
    const r = dynamicTrust(b, stats) - dynamicTrust(a, stats)
    // 时间同样用数值比较：+08:00 与 Z 混用时 localeCompare 会判反
    if (r !== 0) return r
    const ta = Date.parse(String(a.time ?? ''))
    const tb = Date.parse(String(b.time ?? ''))
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
  })
  const picked = ranked.slice(0, n)
  // 关联扩展：命中的记忆把自己 related 的条目带出来（整体最多 3 条，不占检索上限）。
  const seen = new Set(picked.map((f) => f.id).filter(Boolean))
  const extras = []
  for (const f of picked) {
    if (!Array.isArray(f.related)) continue
    for (const rid of f.related) {
      if (extras.length >= RECALL_RELATED_MAX) break
      if (seen.has(rid)) continue
      const target = pool.find((x) => x.id === rid)
      if (!target) continue
      seen.add(rid)
      extras.push({ ...target, via: 'related' })
    }
    if (extras.length >= RECALL_RELATED_MAX) break
  }
  return [...picked, ...extras]
}

/**
 * 明文凭据模式：命中即拒绝写入记忆库。
 * 原则「宁拦错，不放行」：密钥/密码只进钥匙串，记忆只存指针。
 * 正则要求「键名 + 赋值符 + 值」，日常聊 token 概念、说「忘了密码」不会误伤。
 */
const SECRET_PATTERNS = [
  /sk-[a-z0-9_-]{10,}/i,
  /(api[_-]?key|access[_-]?key|secret|client[_-]?secret)\s*[:：=]\s*\S{6,}/i,
  /(password|passwd|pwd)\s*[:：=]\s*\S{6,}/i,
  /(bearer\s+)?(access[_-]?token|auth[_-]?token|api[_-]?token|token)\s*[:：=]\s*[\w-]{16,}/i,
  /-----BEGIN\s+(RSA|EC|OPENSSH|PGP|DSA)\s+PRIVATE\s+KEY-----/i,
  // 审计 2026-11-03 补：常见云厂商 / 平台的固定前缀凭据（原来只认 sk-，这些全放行）
  /\bAKIA[0-9A-Z]{16}\b/,                      // AWS Access Key ID
  /\bghp_[A-Za-z0-9]{30,}/,                    // GitHub personal access token
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,            // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,            // Slack token
  /\bAIza[0-9A-Za-z_-]{30,}/,                  // Google API key
  // 中文键名的凭据（全角冒号也要挡）
  /(密码|口令|密钥|私钥|令牌|访问密钥)\s*[:：=]\s*\S{4,}/,
]

/** 判断文本是否疑似含明文凭据。 */
export function looksLikeSecret(text) {
  const s = String(text ?? '')
  return SECRET_PATTERNS.some((re) => re.test(s))
}

/**
 * 同一目录的写操作串行化：防「读-改-写」竞争丢行（E08）。
 * 仅覆盖进程内；跨进程共享同一记忆库见 README 边界说明。
 */
const writeChains = new Map()
function queueWriteOp(dir, op) {
  const prev = writeChains.get(dir) ?? Promise.resolve()
  const next = prev.then(op, op)
  writeChains.set(dir, next.catch(() => { /* 链上错误已被 op 吸收 */ }))
  return next
}

/**
 * 追加一条记忆。options：
 *  - source: owner/self/evidence/tool/inferred（默认 inferred，没说来源就当推断，垫底）
 *  - subject: 可选键。给了就做「同键新压旧」：库中同 subject 的 active 旧条全部盖章作废
 *    （不删行，supersededBy 指向新条）。不给则纯追加。
 *  - related: 可选，关联到既有记忆。每项可以是记忆 id，或一段内容片段（命中最近的一条 active 即算）。
 *    解析后写入 related（最多 5 个 id）；解析不到的跳过并回报 unresolved。
 *  - maxFacts: 保留上限
 *  - importance: 可选，0–10 的重要度（agent 自己判断「这事有多戳人」）。不给就写进启发式分，
 *    保证每条新记忆都有数，读的时候不用再猜。
 */
export async function appendFact(dir, content, { source = 'inferred', subject = null, related = [], maxFacts = 2000, validFrom = null, validTo = null, importance = null } = {}) {
  const entry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    content: String(content ?? '').trim(),
    source: String(source ?? 'inferred') || 'inferred',
    status: 'active',
  }
  if (typeof subject === 'string' && subject.trim()) entry.subject = subject.trim()
  // 重要度（0.5）：显式给的优先，没给就用启发式估一个——新写的每条都带数，读的时候不猜。
  // 用的是「传进来的 related」做信号，真正的 id 解析在锁里做，这里只关心有没有挂关联。
  entry.importance = normalizeImportance(importance) ?? heuristicImportance({ ...entry, related })
  // 有效期（可选）：不带就永不过期，和以前的行为一致
  // 校验格式：写「明年七月」这种会被静默收下，然后 parse 失败 → 永远算有效（UX 审计 2026-11-03）
  if (typeof validFrom === 'string' && validFrom.trim()) {
    const v = validFrom.trim()
    if (!isDateLike(v)) return { appended: false, entry, error: `validFrom 不是可识别的日期：「${v}」。用 YYYY-MM-DD（如 2026-09-01）或带时区的 ISO 时间。` }
    entry.validFrom = v
  }
  if (typeof validTo === 'string' && validTo.trim()) {
    const v = validTo.trim()
    if (!isDateLike(v)) return { appended: false, entry, error: `validTo 不是可识别的日期：「${v}」。用 YYYY-MM-DD（如 2027-07-01）或带时区的 ISO 时间。` }
    entry.validTo = v
  }
  if (!entry.content) return { appended: false, entry, error: '内容为空，未写入。' }
  // 单条长度上限（审计 2026-11-03：16 万字符一条能把开机注入块撑到 16 万，
  // maxInjectChars 只管人格卡）。超了拒绝写，不静默截断——截断会悄悄丢信息。
  if (entry.content.length > MAX_CONTENT_CHARS) {
    return {
      appended: false,
      entry,
      error: `内容太长：${entry.content.length} 字符，上限 ${MAX_CONTENT_CHARS}。拆成几条再记，或者先精简。`,
    }
  }
  if (looksLikeSecret(entry.content)) return { appended: false, entry, error: '疑似明文凭据，拒绝写入（宁拦错，不放行）。密钥/密码只进钥匙串，记忆只存指针。' }
  // 同键替换会盖掉旧记录：如果新记录自己就不在生效期，盖完这个键就没有效记忆了
  // （审计 2026-11-03：旧值被关掉、新值 validTo=2020 立即过期 → 该键 0 条有效，工具还只说「记住了」）
  if (entry.subject && !isEffective(entry)) {
    return {
      appended: false,
      entry,
      error: '这条带 subject 的新记录本身不在生效期（validFrom 还没到，或 validTo 已过）。写进去会把旧记录盖掉、这个键就断了。请先调整有效期再记。',
    }
  }
  // 文件读-改-写整体进锁：进程内串行 + 跨进程 facts.lock（与桌宠侧同协议）
  return queueWriteOp(dir, async () => {
    const handle = await acquireFileLock(dir)
    try {
      return await appendFactLocked(dir, entry, related, maxFacts)
    } finally {
      await releaseFileLock(handle, dir)
    }
  })
}

async function appendFactLocked(dir, entry, related, maxFacts) {
  const path = join(dir, FACTS_FILE)
  const lines = (await readTextSafe(path)).split('\n').filter((l) => l.trim())
  // 关联解析：id 直接认；内容片段取最近一条命中的 active 记忆。
  const unresolved = []
  if (Array.isArray(related) && related.length) {
    const active = []
    for (const line of lines) {
      try {
        const o = JSON.parse(line)
        if (o && (o.status ?? 'active') === 'active' && typeof o.content === 'string') active.push(o)
      } catch { /* 坏行忽略 */ }
    }
    const ids = []
    for (const raw of related.slice(0, 8)) {
      const s = String(raw ?? '').trim()
      if (!s) continue
      const byId = active.find((o) => o.id === s)
      if (byId) { if (!ids.includes(byId.id) && byId.id !== entry.id) ids.push(byId.id); continue }
      const byContent = active.filter((o) => o.content.includes(s)).slice(-1)[0]
      if (byContent && !ids.includes(byContent.id) && byContent.id !== entry.id) ids.push(byContent.id)
      else if (!byContent) unresolved.push(s)
    }
    if (ids.length) entry.related = ids.slice(0, 5)
  }
  // 同键替换：旧行重写为 superseded（不删行）
  if (entry.subject) {
    for (let i = 0; i < lines.length; i++) {
      let obj
      try { obj = JSON.parse(lines[i]) } catch { continue }
      if (obj && obj.subject === entry.subject && (obj.status ?? 'active') === 'active') {
        obj.status = 'superseded'
        obj.supersededBy = entry.id
        obj.retractNote = `被同键新记忆取代（subject=${entry.subject}）`
        // 给旧条补结束时间，历史链才连得上（SCD2 的做法：新事实进来先关掉旧的）
        // 新条有 validFrom 就用它，否则用新条写入时刻——旧条从这一刻起不再成立。
        if (!obj.validTo) obj.validTo = entry.validFrom || entry.time
        lines[i] = JSON.stringify(obj)
      }
    }
  }
  // 重复内容去重（只看 active 的重复才拦）
  for (const line of lines) {
    try {
      const o = JSON.parse(line)
      if (o && o.content === entry.content && (o.status ?? 'active') === 'active') {
        return { appended: false, entry, duplicated: true }
      }
    } catch {
      /* 坏行忽略 */
    }
  }
  lines.push(JSON.stringify(entry))
  const cap = Math.max(100, Math.min(Number(maxFacts) || 2000, 100000))
  const kept = lines.length > cap ? lines.slice(-cap) : lines
  await atomicWriteFacts(dir, kept.join('\n') + '\n')
  return { appended: true, entry, unresolved }
}

/**
 * 把一条 active 记忆盖章作废（不删行）。
 * 按 content 片段从后往前匹配最近一条 active 命中行，标 superseded + retractNote。
 */
export async function retractFact(dir, query, { note = '' } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { found: false, error: '没有给出要作废的内容片段。' }
  return queueWriteOp(dir, async () => {
    const handle = await acquireFileLock(dir)
    try {
      return await retractFactLocked(dir, q, note)
    } finally {
      await releaseFileLock(handle, dir)
    }
  })
}

async function retractFactLocked(dir, q, note) {
  const path = join(dir, FACTS_FILE)
  const lines = (await readTextSafe(path)).split('\n').filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    if (!obj || typeof obj.content !== 'string') continue
    if ((obj.status ?? 'active') === 'active' && obj.content.includes(q)) {
      obj.status = 'superseded'
      obj.retractNote = note || '（未写原因）'
      obj.retractedAt = new Date().toISOString()
      lines[i] = JSON.stringify(obj)
      await atomicWriteFacts(dir, lines.join('\n') + '\n')
      return { found: true, entry: obj }
    }
  }
  return { found: false }
}

/**
 * 写覆盖之前把旧版留进 history/ 子目录，保留最近 keep 份。
 * 归档失败绝不影响主写入（不抛）。
 * 文件名：<file>.<YYYY-MM-DDTHH-mm-ss-SSSZ>（ISO 时间戳去冒号去点，Windows 文件名合法）。
 */
async function archiveOld(dir, file, keep = 10) {
  try {
    const target = join(dir, file)
    const old = await fs.readFile(target, 'utf8')
    if (!old.trim()) return
    const histDir = join(dir, 'history')
    await fs.mkdir(histDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(join(histDir, `${file}.${stamp}`), old, 'utf8')
    const copies = (await fs.readdir(histDir))
      .filter((n) => n.startsWith(file + '.') && !n.endsWith('.tmp'))
      .sort() // 时间戳前缀，字典序即时间序
    const overflow = copies.length - Math.max(1, Math.min(Number(keep) || 10, 200))
    for (const n of copies.slice(0, Math.max(0, overflow))) {
      await fs.unlink(join(histDir, n)).catch(() => {})
    }
  } catch { /* 归档失败不挡写入 */ }
}

/** 整体覆盖写入某个记忆库文件（写前自动留历史副本）。 */
export async function writeStoreFile(dir, file, content) {
  return queueWriteOp(dir, async () => {
    await fs.mkdir(dir, { recursive: true })
    await archiveOld(dir, file)
    await fs.writeFile(join(dir, file), String(content ?? ''), 'utf8')
  })
}

/** history/ 里某个文件的历史副本数（给 relay_status 展示用）。 */
export async function storeHistoryCount(dir, file) {
  try {
    const names = await fs.readdir(join(dir, 'history'))
    return names.filter((n) => n.startsWith(file + '.') && !n.endsWith('.tmp')).length
  } catch {
    return 0
  }
}

/** 记忆库状态：文件大小、修改时间、记忆条数。 */
export async function storeStats(dir) {
  const out = { dir }
  for (const file of [PERSONA_FILE, HANDOVER_FILE, FACTS_FILE]) {
    try {
      const st = await fs.stat(join(dir, file))
      out[file] = { bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() }
    } catch {
      out[file] = null
    }
  }
  const facts = await parseFacts(dir)
  out.factCount = facts.length
  out.activeCount = facts.filter((f) => f.status === 'active').length
  out.supersededCount = facts.filter((f) => f.status === 'superseded').length
  out.archivedCount = facts.filter((f) => f.status === 'archived').length
  out.latestFactAt = facts.length > 0 ? facts[facts.length - 1].time : null
  return out
}

/**
 * 轻量指纹：只 stat，不读内容、不解析 jsonl。
 * 用于「别的会话写了档没有」的跨会话变更检测（pre-step 里跑，必须够便宜）。
 * 指纹 = mtimeMs + size，双保险（同一毫秒内改写也能靠 size 区分）。
 */
export async function storeStamps(dir) {
  const out = {}
  for (const [key, file] of [['persona', PERSONA_FILE], ['handover', HANDOVER_FILE], ['facts', FACTS_FILE]]) {
    try {
      const st = await fs.stat(join(dir, file))
      out[key] = st.mtimeMs + st.size
    } catch {
      out[key] = 0
    }
  }
  return out
}
