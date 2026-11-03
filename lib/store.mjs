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

export const PERSONA_FILE = 'persona.md'
export const HANDOVER_FILE = 'handover.md'
export const FACTS_FILE = 'facts.jsonl'
export const LOCK_FILE = 'facts.lock'

/**
 * 跨进程写锁（与桌宠侧 pet/chat/relay_store.py 同协议，2026-11-02 补齐）：
 * facts.lock 独占创建（'wx'）；内容 {pid,time} 供诊断；修改时间超过
 * LOCK_STALE_SECONDS 视为持有者崩溃残留，可删除抢占；等待上限 LOCK_WAIT_SECONDS。
 * 桌宠与 DSH 同时写同一份 facts.jsonl 时排队串行，不再「后写覆盖」。
 */
const LOCK_STALE_MS = 30000
const LOCK_WAIT_MS = 5000
const LOCK_POLL_MS = 50

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
        const st = await fs.stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath)
          continue
        }
      } catch {
        continue // 锁刚被释放：下一轮重试创建
      }
      if (Date.now() >= deadline) throw new Error(`facts.lock 获取超时: ${lockPath}`)
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

const PERSONA_TEMPLATE = [
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

const HANDOVER_TEMPLATE = [
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
        facts.push(f)
      }
    } catch {
      /* 坏行跳过，不影响其余记忆 */
    }
  }
  return facts
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
export async function pickFactsForInjection(dir, { limit = 20, pinSources = ['owner', 'self'], pinWindow = 300, pinMax = 0 } = {}) {
  const facts = await parseFacts(dir)
  const pool = facts.filter((f) => f.status === 'active')
  const n = Math.max(1, Math.min(Number(limit) || 20, 1000))
  const base = pool.slice(-n).reverse()
  const pinSet = new Set((Array.isArray(pinSources) ? pinSources : []).filter(Boolean))
  const cap = Math.max(0, Math.min(Math.round(Number(pinMax) || 0) || Math.ceil(n / 3), n))
  if (pinSet.size === 0 || cap === 0) return base
  // 去重键：老数据可能没有 id，用时间+内容兜底
  const keyOf = (f) => f.id || String(f.time) + '|' + f.content
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

/** 反义词对：只收最常见的几组，宁缺勿滥。 */
const ANTONYM_PAIRS = [
  ['喜欢', '讨厌'], ['爱', '恨'], ['支持', '反对'], ['同意', '拒绝'],
  ['成功', '失败'], ['有效', '失效'], ['能', '不能'], ['会', '不会'],
  ['可以', '不可以'], ['要', '不要'], ['是', '不是'], ['行', '不行'],
]

function antonymPair(a, b) {
  for (const [x, y] of ANTONYM_PAIRS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) {
      const strip = (s) => s.split(x).join('').split(y).join('')
      return { restA: strip(a), restB: strip(b), pair: `${x}/${y}` }
    }
  }
  return null
}

/**
 * 找出可能互相矛盾的记忆对。只比较最近 scanLimit 条 active。
 * 同 subject 的两条跳过——那是同键替换的管辖范围，写完已经自动盖章了。
 */
export function findConflicts(facts, { minSim = 0.55, scanLimit = 200 } = {}) {
  const pool = (Array.isArray(facts) ? facts : []).filter((f) => (f.status ?? 'active') === 'active')
  // 自己按时间排一遍，不依赖调用方给的顺序（readFacts 是最新在前，parseFacts 是正序）
  const ordered = pool.slice().sort((x, y) => String(x.time ?? '').localeCompare(String(y.time ?? '')))
  const recent = ordered.slice(-Math.max(2, Math.round(Number(scanLimit) || 200)))
  const sim = Number(minSim) || 0.55
  const items = recent.map((f) => {
    const { norm, negCount } = normalizeForConflict(f.content)
    return { f, norm, negCount, grams: bigrams(norm), chars: unigrams(norm) }
  })
  const pairs = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.f.subject && b.f.subject && a.f.subject === b.f.subject) continue
      // 双字组看语序，单字集合兜住「否定词夹在词中间」的漏。
      // 单字集合只用于短句：长文本共享常用字（「主人」「2026」）会让相似度虚高，
      // 实测两段无关流水能到 0.4+，所以长文本一律只用双字组。
      const short = a.norm.length <= 20 && b.norm.length <= 20
      const score = short
        ? Math.max(jaccard(a.grams, b.grams), jaccard(a.chars, b.chars))
        : jaccard(a.grams, b.grams)
      let reason = ''
      if (a.negCount !== b.negCount && score >= sim) {
        reason = 'negation'
      } else {
        const ant = antonymPair(a.norm, b.norm)
        if (ant && jaccard(bigrams(ant.restA), bigrams(ant.restB)) >= sim * 0.6) {
          reason = 'antonym:' + ant.pair
        }
      }
      if (reason) pairs.push({ a: a.f, b: b.f, similarity: Math.round(score * 1000) / 1000, reason })
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity)
}

/** 来源可信度：截断时先保主人原话/自己答应过的事，推断垫底。 */
export const SOURCE_RANK = { owner: 5, self: 4, evidence: 3, tool: 2, unknown: 1, inferred: 1 }
export const RECALL_HARD_LIMIT = 20
export const RECALL_RELATED_MAX = 3

/**
 * 按关键词回忆：命中 content（或 subject）的条目，先按来源可信度、再按时间新→旧排序截断，
 * 命中条目的 related 关联会带出（最多 3 条，标 via: 'related'）。空 query = 最近条目。
 * 默认只出 active；作废/归档不参与。
 */
export async function recallFacts(dir, query, { limit = 10, all = false } = {}) {
  const facts = await parseFacts(dir)
  const pool = all ? facts : facts.filter((f) => f.status === 'active')
  const n = Math.max(1, Math.min(Number(limit) || 10, RECALL_HARD_LIMIT))
  const q = String(query ?? '').trim().toLowerCase()
  const hit = (f) => f.content.toLowerCase().includes(q) || (f.subject && f.subject.toLowerCase().includes(q))
  const matched = q === '' ? pool : pool.filter(hit)
  const ranked = matched.slice().sort((a, b) => {
    const r = (SOURCE_RANK[b.source] ?? 1) - (SOURCE_RANK[a.source] ?? 1)
    return r !== 0 ? r : String(b.time).localeCompare(String(a.time))
  })
  const picked = ranked.slice(0, n)
  if (q === '') return picked
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
  /(api[_-]?key|access[_-]?key|secret|client[_-]?secret)\s*[:=]\s*\S{6,}/i,
  /(password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
  /(bearer\s+)?(access[_-]?token|auth[_-]?token|api[_-]?token|token)\s*[:=]\s*[\w-]{16,}/i,
  /-----BEGIN\s+(RSA|EC|OPENSSH|PGP|DSA)\s+PRIVATE\s+KEY-----/i,
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
 */
export async function appendFact(dir, content, { source = 'inferred', subject = null, related = [], maxFacts = 2000 } = {}) {
  const entry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    content: String(content ?? '').trim(),
    source: String(source ?? 'inferred') || 'inferred',
    status: 'active',
  }
  if (typeof subject === 'string' && subject.trim()) entry.subject = subject.trim()
  if (!entry.content) return { appended: false, entry, error: '内容为空，未写入。' }
  if (looksLikeSecret(entry.content)) return { appended: false, entry, error: '疑似明文凭据，拒绝写入（宁拦错，不放行）。密钥/密码只进钥匙串，记忆只存指针。' }
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
