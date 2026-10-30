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
        facts.push(f)
      }
    } catch {
      /* 坏行跳过，不影响其余记忆 */
    }
  }
  return facts
}

/** 最近 limit 条记忆，最新在前。默认只出 active（作废的不占位）。 */
export async function readFacts(dir, { limit = 20, all = false } = {}) {
  const facts = await parseFacts(dir)
  const pool = all ? facts : facts.filter((f) => f.status !== 'superseded')
  const n = Math.max(1, Math.min(Number(limit) || 20, 1000))
  return pool.slice(-n).reverse()
}

/** 按关键词回忆：命中 content 的条目，最新在前。空 query = 最近条目。默认只出 active。 */
export async function recallFacts(dir, query, { limit = 10, all = false } = {}) {
  const facts = await parseFacts(dir)
  const pool = all ? facts : facts.filter((f) => f.status !== 'superseded')
  const n = Math.max(1, Math.min(Number(limit) || 10, 100))
  const q = String(query ?? '').trim().toLowerCase()
  const hit = (f) => f.content.toLowerCase().includes(q) || (f.subject && f.subject.toLowerCase().includes(q))
  const matched = q === '' ? pool : pool.filter(hit)
  return matched.slice(-n).reverse()
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
 * 追加一条记忆。options：
 *  - source: owner/self/evidence/tool/inferred（默认 inferred，没说来源就当推断，垫底）
 *  - subject: 可选键。给了就做「同键新压旧」：库中同 subject 的 active 旧条全部盖章作废
 *    （不删行，supersededBy 指向新条）。不给则纯追加。
 *  - maxFacts: 保留上限
 */
export async function appendFact(dir, content, { source = 'inferred', subject = null, maxFacts = 2000 } = {}) {
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
  const path = join(dir, FACTS_FILE)
  const lines = (await readTextSafe(path)).split('\n').filter((l) => l.trim())
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
  await fs.writeFile(path, kept.join('\n') + '\n', 'utf8')
  return { appended: true, entry }
}

/**
 * 把一条 active 记忆盖章作废（不删行）。
 * 按 content 片段从后往前匹配最近一条 active 命中行，标 superseded + retractNote。
 */
export async function retractFact(dir, query, { note = '' } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { found: false, error: '没有给出要作废的内容片段。' }
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
      await fs.writeFile(path, lines.join('\n') + '\n', 'utf8')
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
  await fs.mkdir(dir, { recursive: true })
  await archiveOld(dir, file)
  await fs.writeFile(join(dir, file), String(content ?? ''), 'utf8')
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
  out.activeCount = facts.filter((f) => f.status !== 'superseded').length
  out.supersededCount = facts.length - out.activeCount
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
