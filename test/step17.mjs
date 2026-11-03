// step17.mjs — 0.5 记忆重要度：显式打分 / 启发式兜底 / 注入排序用它
// 运行：node test/step17.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeImportance, heuristicImportance, importanceOf,
  appendFact, pickFactsForInjection, parseFacts,
} from '../lib/store.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── 归一化：夹成 0–10 整数，空值 = 没给 ──
ok('null 当没给', normalizeImportance(null) === null)
ok('空串当没给', normalizeImportance('') === null)
ok('非数字当没给', normalizeImportance('abc') === null)
ok('字符串数字认', normalizeImportance('8') === 8)
ok('四舍五入', normalizeImportance(5.6) === 6)
ok('负数夹到 0', normalizeImportance(-3) === 0)
ok('超大夹到 10', normalizeImportance(99) === 10)

// ── 启发式兜底 ──
ok('owner 基础 8', heuristicImportance({ source: 'owner', content: '随便一句' }) === 8)
ok('tool 基础 3', heuristicImportance({ source: 'tool', content: '随便一句' }) === 3)
ok('未知来源 2', heuristicImportance({ source: 'zzz', content: 'x' }) === 2)
ok('信号词 +2 封顶 10', heuristicImportance({ source: 'owner', content: '主人说永远记住这件事' }) === 10)
ok('有 subject +1', heuristicImportance({ source: 'owner', content: '随便一句', subject: 'k' }) === 9)
ok('有 related +1', heuristicImportance({ source: 'tool', content: '随便一句', related: ['x'] }) === 4)

// ── 显式优先，老数据走兜底 ──
ok('显式分压过来源基础分', importanceOf({ source: 'owner', content: 'x', importance: 2 }) === 2)
ok('显式 0 不会被当成没给', importanceOf({ source: 'owner', content: 'x', importance: 0 }) === 0)
ok('老数据没有 importance 也能算', importanceOf({ source: 'tool', content: 'x' }) === 3)
ok('重要性字段坏了也兜底', importanceOf({ source: 'tool', content: 'x', importance: 'bad' }) === 3)

// ── 写入时就落数 ──
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step17-'))
await appendFact(DIR, '主人说这件事很重要', { source: 'owner', importance: 9 })
await appendFact(DIR, '今天跑了测试', { source: 'tool' })
const rows = await parseFacts(DIR)
ok('显式 importance 写进文件', rows.some((r) => r.importance === 9))
ok('没给 importance 也落一个启发式值', rows.some((r) => r.source === 'tool' && r.importance === 3))

// ── 注入排序：其他条件一样时，重要度高的先被挑中 ──
const DIR2 = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step17b-'))
const row = (id, content, importance, time) => ({ id, content, source: 'tool', status: 'active', importance, time })
await fs.writeFile(path.join(DIR2, 'facts.jsonl'), [
  row('low', '主人喜欢喝咖啡（流水）', 1, '2026-11-01T00:00:00.000Z'),
  row('high', '主人喜欢喝咖啡（承诺）', 10, '2026-11-01T00:00:00.000Z'),
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const picked = await pickFactsForInjection(DIR2, { limit: 1, pinSources: [], mode: 'relevance', query: '主人喜欢喝咖啡' })
ok('同样相关、同样新鲜时，重要度高的赢', picked.length === 1 && picked[0].id === 'high')

const legacy = await pickFactsForInjection(DIR2, { limit: 2, pinSources: [], mode: 'relevance', query: '主人喜欢喝咖啡' })
ok('缺 importance 的老数据不影响挑选', legacy.length === 2)

await fs.rm(DIR, { recursive: true, force: true })
await fs.rm(DIR2, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
