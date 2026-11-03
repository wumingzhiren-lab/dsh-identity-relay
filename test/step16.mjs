// step16.mjs — 0.5 注入体积预算：clipFactsToBudget + buildInjection 接线
// 运行：node test/step16.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clipFactsToBudget } from '../lib/store.mjs'
import { buildInjection } from '../index.js'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

const f = (content) => ({ id: content, content, source: 'tool', status: 'active', time: '2026-11-01T00:00:00.000Z' })

// ── 纯函数 ──
const r1 = clipFactsToBudget([], 1000)
ok('空表不崩', r1.kept.length === 0 && r1.dropped === 0)

const three = [f('甲甲甲'), f('乙乙乙'), f('丙丙丙')]
const r2 = clipFactsToBudget(three, 100000)
ok('预算够时全保留', r2.kept.length === 3 && r2.dropped === 0)

// 每条 3 字符 + 每行开销 40 = 43；预算 100 只放得下 2 条
const r3 = clipFactsToBudget(three, 100)
ok('超预算按顺序从尾部丢', r3.kept.length === 2 && r3.dropped === 1 && r3.kept[0].content === '甲甲甲')

const r4 = clipFactsToBudget(three, 1)
ok('预算再小也至少留 1 条（读档不能没有记忆）', r4.kept.length === 1 && r4.dropped === 2)

const r5 = clipFactsToBudget(three, 0)
ok('预算 0 = 不设限', r5.kept.length === 3)

const r6 = clipFactsToBudget(three, -5)
ok('负数预算也当不设限', r6.kept.length === 3)

const r7 = clipFactsToBudget(three, 200, { perLineOverhead: 0 })
ok('每行开销可调（3×3 字符 = 9 字符放得下）', r7.kept.length === 3)

const long = [f('长'.repeat(4000)), f('短')]
const r8 = clipFactsToBudget(long, 500)
ok('超长单条自己就超预算时，按顺序先留它（至少 1 条）', r8.kept.length === 1 && r8.kept[0].content.length === 4000)

// ── 接线：buildInjection 真的用了预算 ──
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step16-'))
const row = (id, content, time) => ({ id, time, content, source: 'tool', status: 'active' })
// 文件顺序 = 追加顺序（旧的在前），最近的那条在最后一行
await fs.writeFile(path.join(DIR, 'facts.jsonl'), [
  row('c', '丙'.repeat(300), '2026-11-01T10:00:00.000Z'),
  row('b', '乙'.repeat(300), '2026-11-02T10:00:00.000Z'),
  row('a', '甲'.repeat(300), '2026-11-03T10:00:00.000Z'),
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
await fs.writeFile(path.join(DIR, 'persona.md'), '# 人格卡\n\n- 名字：小鲸\n', 'utf8')
await fs.writeFile(path.join(DIR, 'handover.md'), '# 交接书\n\n今天在改检索代码。\n', 'utf8')

const cfg = {
  recallLimit: 20,
  pinSources: [],
  pinWindow: 300,
  pinMax: 0,
  maxInjectChars: 6000,
  maxHandoverChars: 4000,
  injectSelect: 'recent',
}
const wide = await buildInjection('startup', { ...cfg, maxFactsChars: 100000 }, DIR)
ok('预算宽时三条都进', (wide.match(/^- \[/gm) || []).length === 3)
ok('预算宽时不说「超出预算」', !wide.includes('超出注入预算'))

const narrow = await buildInjection('startup', { ...cfg, maxFactsChars: 400 }, DIR)
ok('预算窄时少进', (narrow.match(/^- \[/gm) || []).length < 3)
ok('预算窄时留的是排在前面的（最新）', narrow.includes('甲'.repeat(20)))
ok('预算窄时告诉去哪捞剩下的', narrow.includes('超出注入预算没放进来'))

const noBudget = await buildInjection('startup', { ...cfg, maxFactsChars: 0 }, DIR)
ok('预算 0 时全进（关掉预算）', (noBudget.match(/^- \[/gm) || []).length === 3)

// 调用点形状回归：漏传 maxFactsChars 时按默认 8000 走，不能静默变成「不设限」
await fs.writeFile(path.join(DIR, 'facts.jsonl'), [
  row('a', '甲'.repeat(4000), '2026-11-03T10:00:00.000Z'),
  row('b', '乙'.repeat(4000), '2026-11-02T10:00:00.000Z'),
  row('c', '丙'.repeat(4000), '2026-11-01T10:00:00.000Z'),
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const byDefault = await buildInjection('startup', { ...cfg, maxFactsChars: undefined }, DIR)
const explicit8k = await buildInjection('startup', { ...cfg, maxFactsChars: 8000 }, DIR)
const countLines = (s) => (s.match(/^- \[/gm) || []).length
ok('漏传 maxFactsChars 时与显式 8000 一致', countLines(byDefault) === countLines(explicit8k))
ok('默认预算确实生效（1.2 万字符不会全进）', countLines(byDefault) < 3)
const unlimited = await buildInjection('startup', { ...cfg, maxFactsChars: 0 }, DIR)
ok('设成 0 才真的不设限', countLines(unlimited) === 3)

await fs.rm(DIR, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
