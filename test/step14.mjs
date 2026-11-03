// step14.mjs — 0.5 读档按相关性挑记忆（pickFactsForInjection mode: 'relevance'）
// 运行：node test/step14.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pickFactsForInjection, relevanceOf, bigrams } from '../lib/store.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step14-'))
const writeStore = async (rows) => {
  await fs.writeFile(path.join(DIR, 'facts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}
const row = (id, time, content, source = 'tool', extra = {}) => ({ id, time, content, source, status: 'active', ...extra })

// 文件顺序 = 追加顺序（真实的 facts.jsonl 就是这样），时间也是递增的
const ROWS = [
  row('a', '2026-09-01T00:00:00.000Z', '主人喜欢喝咖啡，不加糖', 'owner'),
  row('c', '2026-10-20T00:00:00.000Z', '方言训练等主人发起', 'tool'),
  row('b', '2026-11-03T10:00:00.000Z', '主人今天在改 identity-relay 的检索代码', 'tool'),
]
await writeStore(ROWS)
const ids = (list) => list.map((f) => f.id)

// ── 相关性分数本身 ──
ok('完全覆盖相关性高', relevanceOf(bigrams('主人喜欢喝咖啡'), '主人喜欢喝咖啡') > 0.7)
ok('无关内容相关性为 0', relevanceOf(bigrams('主人喜欢喝咖啡'), '方言训练') === 0)
ok('空事实不崩', relevanceOf(bigrams('x'), '') === 0)

// ── recent 模式：v0.4 行为不变 ──
const r1 = await pickFactsForInjection(DIR, { limit: 2, pinSources: [], mode: 'recent' })
ok('recent 模式仍是最近 2 条、新→旧', ids(r1).join(',') === 'b,c')

// ── relevance 模式：按话题挑，而不是按时间 ──
const r2 = await pickFactsForInjection(DIR, { limit: 1, pinSources: [], mode: 'relevance', query: 'identity-relay 检索 代码' })
ok('相关性挑中最新那条（正好也相关）', ids(r2).join(',') === 'b')
const r3 = await pickFactsForInjection(DIR, { limit: 1, pinSources: [], mode: 'relevance', query: '咖啡 不加糖' })
ok('相关性能把最老的那条顶到第一', ids(r3).join(',') === 'a')
const r4 = await pickFactsForInjection(DIR, { limit: 2, pinSources: [], mode: 'relevance', query: '方言训练' })
ok('相关性挑中 c', ids(r4)[0] === 'c')
ok('名额上限被遵守', r4.length === 2)
ok('不会重复出同一条', new Set(ids(r4)).size === r4.length)

// ── 没有话题就退回 recent（永远有兜底）──
const r5 = await pickFactsForInjection(DIR, { limit: 2, pinSources: [], mode: 'relevance', query: '   ' })
ok('空白 query 退回最近 2 条', ids(r5).join(',') === 'b,c')
const r6 = await pickFactsForInjection(DIR, { limit: 2, pinSources: [], mode: 'relevance' })
ok('不给 query 也退回最近 2 条', ids(r6).join(',') === 'b,c')

// ── 保底名额在 relevance 模式下也生效 ──
const r7 = await pickFactsForInjection(DIR, { limit: 1, pinSources: ['owner'], mode: 'relevance', query: '方言训练' })
ok('名额 1 时保底来源压过相关性（不丢主人原话）', ids(r7).join(',') === 'a')
const r8 = await pickFactsForInjection(DIR, { limit: 3, pinSources: ['owner'], mode: 'relevance', query: '方言训练' })
ok('名额够时保底和相关性都在', ids(r8).includes('a') && ids(r8).includes('c'))

// ── 不成立的记忆不占名额 ──
await writeStore([
  ...ROWS,
  row('d', '2026-10-01T00:00:00.000Z', '咖啡这件事已经过去（过期样例）', 'tool', { validTo: '2026-10-02' }),
])
const r9 = await pickFactsForInjection(DIR, { limit: 5, pinSources: [], mode: 'relevance', query: '咖啡 过期' })
ok('过期记忆不进入相关性挑选', !ids(r9).includes('d'))
const r10 = await pickFactsForInjection(DIR, { limit: 5, pinSources: [], mode: 'recent' })
ok('过期记忆也不进 recent 挑选', !ids(r10).includes('d'))

// ── 库比名额小时全给 ──
await writeStore([ROWS[1], ROWS[2]])
const r11 = await pickFactsForInjection(DIR, { limit: 10, pinSources: [], mode: 'relevance', query: '检索' })
ok('库比名额小时全给', r11.length === 2)

await fs.rm(DIR, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
