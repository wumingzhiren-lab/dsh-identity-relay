// step7.mjs — 记忆矛盾检测（纯规则：否定差异 + 正反义）端到端测试
// 运行：node test/step7.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, readFacts, retractFact, findConflicts, normalizeForConflict, bigrams, jaccard } from '../lib/store.mjs'

const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step7-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── 单元：归一化 ──
const n1 = normalizeForConflict('主人不喜欢喝咖啡。')
ok('negCount 记到 1', n1.negCount === 1)
ok('归一化去掉否定词/虚词/标点', n1.norm === '主人喜欢喝咖啡')
const n2 = normalizeForConflict('主人喜欢喝咖啡')
ok('无否定词时 negCount=0', n2.negCount === 0)

// ── 单元：双字组与 Jaccard ──
ok('bigrams 两字文本=1 组', bigrams('咖啡').size === 1)
ok('相同文本 Jaccard=1', jaccard(bigrams('喝咖啡'), bigrams('喝咖啡')) === 1)
ok('无交集 Jaccard=0', jaccard(bigrams('苹果'), bigrams('香蕉')) === 0)
ok('空集 Jaccard=0', jaccard(bigrams(''), bigrams('咖啡')) === 0)

// ── 场景 ──
await appendFact(DIR, '主人喜欢喝咖啡', { source: 'owner' })
await appendFact(DIR, '主人不喜欢喝咖啡', { source: 'evidence' })
let facts = await readFacts(DIR, { limit: 1000 })
let pairs = findConflicts(facts)
ok('否定差异命中', pairs.some((p) => p.reason === 'negation'))

await appendFact(DIR, '主人喜欢打游戏', { source: 'owner' })
await appendFact(DIR, '主人讨厌打游戏', { source: 'evidence' })
facts = await readFacts(DIR, { limit: 1000 })
pairs = findConflicts(facts)
ok('正反义命中', pairs.some((p) => p.reason.startsWith('antonym')))

await appendFact(DIR, '今天下了很大的雨', { source: 'tool' })
await appendFact(DIR, '主人的电脑是 Windows', { source: 'tool' })
facts = await readFacts(DIR, { limit: 1000 })
pairs = findConflicts(facts)
const cross = (p, x, y) => (p.a.content.includes(x) && p.b.content.includes(y)) || (p.b.content.includes(x) && p.a.content.includes(y))
ok('无关记忆不误报', !pairs.some((p) => cross(p, '下了很大的雨', 'Windows')))

// 单字兜底：否定词夹在词中间，双字组会拼错位（「今天有课」→「今天课」）
await appendFact(DIR, '今天有课', { source: 'owner' })
await appendFact(DIR, '今天没课', { source: 'owner' })
facts = await readFacts(DIR, { limit: 1000 })
pairs = findConflicts(facts)
ok('短句单字否定也能命中', pairs.some((p) => cross(p, '今天有课', '今天没课')))

// 作废条目不参与
await appendFact(DIR, '主人能喝酒', { source: 'owner' })
await appendFact(DIR, '主人不能喝酒', { source: 'owner' })
await retractFact(DIR, '主人能喝酒', { note: '测试作废' })
facts = await readFacts(DIR, { limit: 1000 })
pairs = findConflicts(facts)
ok('作废条目不参与检测', !pairs.some((p) => p.a.content === '主人能喝酒' || p.b.content === '主人能喝酒'))

// ── 结构 ──
ok('结果按相似度降序', pairs.every((p, i) => i === 0 || pairs[i - 1].similarity >= p.similarity))
ok('每对都有 a/b/similarity/reason', pairs.every((p) => p.a && p.b && typeof p.similarity === 'number' && typeof p.reason === 'string' && p.reason))
ok('相似度在 0~1', pairs.every((p) => p.similarity >= 0 && p.similarity <= 1))

// ── 边界 ──
ok('空数组返回空', findConflicts([]).length === 0)
ok('非数组输入返回空', findConflicts(null).length === 0)
ok('单条不报错', findConflicts([{ content: '只有一条', status: 'active', time: '2026-01-01T00:00:00.000Z' }]).length === 0)

// scanLimit 只比最近 N 条
const twoOnly = findConflicts(facts, { scanLimit: 2 })
const lastTwo = facts.slice(0, 2).map((f) => f.id || f.content)
ok('scanLimit 只比最近两条', twoOnly.every((p) => lastTwo.includes(p.a.id || p.a.content) && lastTwo.includes(p.b.id || p.b.content)))

// 同 subject 的两条（手工造，绕过同键替换）不参与矛盾检测
const manual = [
  JSON.stringify({ id: 'm1', time: '2026-01-01T00:00:00.000Z', content: '温度是高的', source: 'tool', status: 'active', subject: 'temp' }),
  JSON.stringify({ id: 'm2', time: '2026-01-02T00:00:00.000Z', content: '温度不是高的', source: 'tool', status: 'active', subject: 'temp' }),
].join('\n') + '\n'
await fs.appendFile(DIR + '/facts.jsonl', manual, 'utf8')
const withManual = await readFacts(DIR, { limit: 1000 })
const manualPairs = findConflicts(withManual)
ok('同 subject 两条跳过（不报否定矛盾）',
  !manualPairs.some((p) => p.a.subject === 'temp' && p.b.subject === 'temp'))

// 输入顺序无关：倒序传进去结果一样
const rev = findConflicts(facts.slice().reverse())
ok('输入顺序无关', rev.length === findConflicts(facts).length)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
