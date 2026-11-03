// step10.mjs — pre-step 提示的决策逻辑：多个条件同时命中时必须**全都出**
// 这一套存在的理由：2026-11-03 真机发现「档案更新提示把增量注入吞了」，
// 而且它早就在吞容量预警。纯函数化 + 这条测试就是防它再犯。
// 运行：node test/step10.mjs（从插件根目录）
import { shouldNudgeCapacity, shouldNudgeArchive, planStepNudges } from '../lib/nudges.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }
const NOW = 1_700_000_000_000

// ── 容量预警 ──
const base = { used: 7000, window: 10000, warnRatio: 0.7, reserveTokens: 100, lastNudgeAt: 0, nudgeMs: 600000, now: NOW }
ok('比例线命中', shouldNudgeCapacity(base) === true)
ok('剩余线命中（比例没到也算）', shouldNudgeCapacity({ ...base, used: 100, warnRatio: 0.99, reserveTokens: 10000 }) === true)
ok('都不到就不预警', shouldNudgeCapacity({ ...base, used: 100, reserveTokens: 1000 }) === false)
ok('节流中不重复预警', shouldNudgeCapacity({ ...base, lastNudgeAt: NOW - 100 }) === false)
ok('窗口无效不预警', shouldNudgeCapacity({ ...base, window: 0 }) === false)
ok('used 为 0 不崩', shouldNudgeCapacity({ ...base, used: 0, reserveTokens: 0 }) === false)

// ── 档案更新 ──
ok('有变更且过了一分钟 → 发', shouldNudgeArchive({ changed: ['facts'], lastNudgeAt: 0, nudgeMs: 60000, now: NOW }) === true)
ok('没有变更 → 不发', shouldNudgeArchive({ changed: [], lastNudgeAt: 0, nudgeMs: 60000, now: NOW }) === false)
ok('节流中 → 不发', shouldNudgeArchive({ changed: ['facts'], lastNudgeAt: NOW - 1000, nudgeMs: 60000, now: NOW }) === false)
ok('非数组不崩', shouldNudgeArchive({ changed: null, lastNudgeAt: 0, nudgeMs: 60000, now: NOW }) === false)

// ── 组合：这就是出过事的地方 ──
const all = planStepNudges({
  changed: ['facts'],
  freshFacts: [{ id: 'a', content: '新记忆', source: 'tool', time: 'x' }],
  capacity: { due: true, used: 9000, window: 10000 },
  archive: { due: true },
  now: NOW,
})
ok('三个条件同时命中 → 三条全出', all.length === 3)
ok('顺序：新记忆 → 档案 → 容量', all[0]?.kind === 'fresh-facts' && all[1]?.kind === 'archive-update' && all[2]?.kind === 'capacity')

const onlyFresh = planStepNudges({ freshFacts: [{ id: 'a' }], now: NOW })
ok('只有新记忆 → 一条', onlyFresh.length === 1 && onlyFresh[0].kind === 'fresh-facts')

const onlyArchive = planStepNudges({ changed: ['handover'], archive: { due: true }, now: NOW })
ok('只有档案 → 一条', onlyArchive.length === 1 && onlyArchive[0].kind === 'archive-update')

const onlyCapacity = planStepNudges({ capacity: { due: true, used: 1, window: 2 }, now: NOW })
ok('只有容量 → 一条', onlyCapacity.length === 1 && onlyCapacity[0].kind === 'capacity')

const none = planStepNudges({ now: NOW })
ok('都没有 → 空数组', none.length === 0)
ok('空参数不崩', planStepNudges().length === 0)
ok('freshFacts 为空数组 → 不出', planStepNudges({ freshFacts: [], now: NOW }).length === 0)

// 这条是核心断言：一个命中不能吃掉另一个
const swallow = planStepNudges({
  freshFacts: [{ id: 'x' }],
  capacity: { due: true, used: 9, window: 10 },
  now: NOW,
})
ok('新记忆 + 容量同时命中 → 都出（不再互相吞）', swallow.length === 2)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
