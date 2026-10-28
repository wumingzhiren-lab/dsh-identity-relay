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

/** 读 facts.jsonl：解析每条 JSON，坏行跳过，返回（按时间正序的）全部条目。 */
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
        facts.push({ time: String(obj.time ?? ''), content: obj.content.trim() })
      }
    } catch {
      /* 坏行跳过，不影响其余记忆 */
    }
  }
  return facts
}

/** 最近 limit 条记忆，最新在前。 */
export async function readFacts(dir, { limit = 20 } = {}) {
  const facts = await parseFacts(dir)
  const n = Math.max(1, Math.min(Number(limit) || 20, 1000))
  return facts.slice(-n).reverse()
}

/** 按关键词回忆：命中 content 的条目，最新在前。空 query = 最近条目。 */
export async function recallFacts(dir, query, { limit = 10 } = {}) {
  const facts = await parseFacts(dir)
  const n = Math.max(1, Math.min(Number(limit) || 10, 100))
  const q = String(query ?? '').trim().toLowerCase()
  const matched = q === '' ? facts : facts.filter((f) => f.content.toLowerCase().includes(q))
  return matched.slice(-n).reverse()
}

/** 追加一条记忆（重复内容去重）。返回 {appended, entry}。 */
export async function appendFact(dir, content, { maxFacts = 2000 } = {}) {
  const entry = { time: new Date().toISOString(), content: String(content ?? '').trim() }
  if (!entry.content) return { appended: false, entry, error: '内容为空，未写入。' }
  const path = join(dir, FACTS_FILE)
  const lines = (await readTextSafe(path)).split('\n').filter((l) => l.trim())
  for (const line of lines) {
    try {
      if ((JSON.parse(line)?.content ?? '') === entry.content) {
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

/** 整体覆盖写入某个记忆库文件。 */
export async function writeStoreFile(dir, file, content) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, file), String(content ?? ''), 'utf8')
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
  out.latestFactAt = facts.length > 0 ? facts[facts.length - 1].time : null
  return out
}
