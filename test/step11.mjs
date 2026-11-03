// step11.mjs — 来源动态信任（按人工判错率降权）+ 记忆年龄标记
// 运行：node test/step11.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, recallFacts, retractFact, dynamicTrust, SOURCE_RANK } from '../lib/store.mjs'
import { sourceTrustStats, ageMs, isStale } from '../lib/trust.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── 统计：区分「同键正常替换」和「人认为记错了」──
const sample = [
  { source: 'owner', status: 'active' },
  { source: 'owner', status: 'superseded', retractNote: '被同键新记忆取代（subject=x）' },
  { source: 'tool', status: 'active' },
  { source: 'tool', status: 'superseded', retractNote: '记错了' },
  { source: 'tool', status: 'archived', archivedBy: 'consolidate' },
]
const st = sourceTrustStats(sample)
ok('owner 写入 2 条', st.owner.writes === 2)
ok('同键替换不算判错', st.owner.manualRetract === 0)
ok('owner 判错率 0', st.owner.retractRate === 0)
ok('tool 判错 2 条（retract + archive）', st.tool.manualRetract === 2)
ok('tool 判错率 2/3', Math.abs(st.tool.retractRate - 2 / 3) < 1e-9)
ok('空输入不崩', Object.keys(sourceTrustStats(null)).length === 0)

// ── 动态信任：降权有上限 ──
ok('无判错 = 基础档', dynamicTrust({ source: 'owner' }, st) === SOURCE_RANK.owner)
const half = dynamicTrust({ source: 'tool' }, { tool: { retractRate: 0.5 } })
ok('判错一半 → 降到 75%', Math.abs(half - SOURCE_RANK.tool * 0.75) < 1e-9)
const allBad = dynamicTrust({ source: 'tool' }, { tool: { retractRate: 1 } })
ok('全判错也只降一半', Math.abs(allBad - SOURCE_RANK.tool * 0.5) < 1e-9)
ok('判错率超界也不变负数', dynamicTrust({ source: 'tool' }, { tool: { retractRate: 5 } }) > 0)
ok('未知来源不崩', dynamicTrust({ source: 'zzz' }, {}) === 1)
ok('空 stats 不崩', dynamicTrust({ source: 'owner' }, null) === SOURCE_RANK.owner)
ok('判错后仍高于更低档位（owner 压不过 tool）', dynamicTrust({ source: 'owner' }, { owner: { retractRate: 1 } }) > dynamicTrust({ source: 'tool' }, { tool: { retractRate: 0 } }))

// ── 年龄 ──
const now = Date.parse('2026-11-03T00:00:00.000Z')
ok('半年前算旧', isStale({ time: '2026-04-01T00:00:00.000Z' }, { now }) === true)
ok('昨天不算旧', isStale({ time: '2026-11-02T00:00:00.000Z' }, { now }) === false)
ok('没有 time 不算旧', isStale({}, { now }) === false)
ok('非法时间不算旧', isStale({ time: '不是时间' }, { now }) === false)
ok('正好 120 天算旧', isStale({ time: '2026-07-06T00:00:00.000Z' }, { now, staleDays: 120 }) === true)
ok('119 天不算旧', isStale({ time: '2026-07-07T00:00:00.000Z' }, { now, staleDays: 120 }) === false)
ok('ageMs 算得对', ageMs({ time: '2026-11-01T00:00:00.000Z' }, now) === 2 * 86400000)
ok('ageMs 非法返回 null', ageMs({ time: 'x' }, now) === null)

// ── 集成：真库路径下 recall 不炸，且判错来源被压后 ──
const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step11-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })

await appendFact(DIR, '偏好：主人喜欢安静', { source: 'owner' })
await appendFact(DIR, '推断：主人可能喜欢热闹', { source: 'inferred' })
await appendFact(DIR, '台账：某次操作记录', { source: 'tool' })
await appendFact(DIR, '台账：另一条操作记录', { source: 'tool' })
await retractFact(DIR, '台账：另一条操作记录', { note: '记错了' })

const r = await recallFacts(DIR, '主人')
ok('recall 正常返回', r.length >= 2)
ok('owner 排在 inferred 前', r[0].source === 'owner')

const stats2 = sourceTrustStats(await (async () => {
  const { parseFacts } = await import('../lib/store.mjs')
  return parseFacts(DIR)
})())
ok('真库统计里 tool 有判错', stats2.tool && stats2.tool.manualRetract === 1)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
