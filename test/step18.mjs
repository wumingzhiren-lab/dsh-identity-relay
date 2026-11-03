// step18.mjs — 0.5 冲突处理：稳定编号 / 建议动作 / 显式执行（不自动）
// 运行：node test/step18.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  conflictPairId, suggestConflictAction, resolveConflict, findConflicts, parseFacts,
} from '../lib/store.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── 稳定编号：A/B 互换不换号，不同对不撞 ──
const a = { id: 'id-a' }
const b = { id: 'id-b' }
ok('编号稳定', conflictPairId(a, b) === conflictPairId(a, b))
ok('A/B 互换不换号', conflictPairId(a, b) === conflictPairId(b, a))
ok('不同对编号不同', conflictPairId(a, b) !== conflictPairId(a, { id: 'id-c' }))
ok('没有 id 时用内容也能算', conflictPairId({ content: '甲' }, { content: '乙' }).length === 8)
ok('编号固定 8 位', /^[0-9a-f]{8}$/.test(conflictPairId(a, b)))

// ── 建议动作：保守，只给建议 ──
const olderTool = { id: 'o', content: '主人不喜欢喝咖啡', source: 'tool', time: '2026-11-01T00:00:00.000Z' }
const newerOwner = { id: 'n', content: '主人喜欢喝咖啡', source: 'owner', time: '2026-11-03T00:00:00.000Z' }
ok('旧的是流水、新的是主人 → 建议盖旧的', suggestConflictAction({ a: olderTool, b: newerOwner }).action === 'retract-older')

const olderOwner = { id: 'o2', content: '主人喜欢喝咖啡', source: 'owner', time: '2026-11-01T00:00:00.000Z' }
const newerTool = { id: 'n2', content: '主人不喜欢喝咖啡', source: 'tool', time: '2026-11-03T00:00:00.000Z' }
ok('旧的是主人原话 → 一律 manual', suggestConflictAction({ a: olderOwner, b: newerTool }).action === 'manual')

const olderHigh = { id: 'o3', content: 'x', source: 'evidence', time: '2026-11-01T00:00:00.000Z' }
const newerLow = { id: 'n3', content: 'y', source: 'inferred', time: '2026-11-03T00:00:00.000Z' }
ok('新的来源档更低 → manual', suggestConflictAction({ a: olderHigh, b: newerLow }).action === 'manual')

ok('同一时刻 → manual', suggestConflictAction({ a: { ...olderTool, time: '2026-11-03T00:00:00.000Z' }, b: newerOwner }).action === 'manual')
ok('时间缺失 → manual', suggestConflictAction({ a: { ...olderTool, time: '' }, b: newerOwner }).action === 'manual')
ok('空 pair 不崩', suggestConflictAction(null).action === 'manual')

// ── 显式执行：不自动、主人原话不盖、作废不删行 ──
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step18-'))
const row = (id, content, source, time) => ({ id, content, source, status: 'active', time })
await fs.writeFile(path.join(DIR, 'facts.jsonl'), [
  row('old', '主人不喜欢喝咖啡', 'tool', '2026-11-01T00:00:00.000Z'),
  row('new', '主人喜欢喝咖啡', 'owner', '2026-11-03T00:00:00.000Z'),
  row('own', '方言训练等主人发起', 'owner', '2026-11-02T00:00:00.000Z'),
  row('tool2', '方言训练先不搞了', 'tool', '2026-11-03T12:00:00.000Z'),
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const facts = await parseFacts(DIR)
const pairs = findConflicts(facts, { scanLimit: 200 })
ok('检测出冲突对', pairs.length >= 1)
ok('冲突对自带编号', pairs.every((p) => /^[0-9a-f]{8}$/.test(p.id)))

const coffee = pairs.find((p) => p.a.content.includes('咖啡') && p.b.content.includes('咖啡'))
ok('咖啡那对被抓到', Boolean(coffee))

const bad = await resolveConflict(DIR, pairs, { pairId: 'deadbeef', which: 'a' })
ok('编号不存在时给明确错误', bad.ok === false && /没找到/.test(bad.error))

// 主人原话不能被这个口子盖（无论 A 还是 B）
const targetIsOwner = coffee.a.source === 'owner' ? 'a' : 'b'
const refused = await resolveConflict(DIR, pairs, { pairId: coffee.id, which: targetIsOwner })
ok('主人原话拒绝在这里被盖', refused.ok === false && /主人原话/.test(refused.error))
ok('拒绝时没动数据', (await parseFacts(DIR)).every((f) => f.status === 'active'))

const okResolve = await resolveConflict(DIR, pairs, { pairId: coffee.id, which: targetIsOwner === 'a' ? 'b' : 'a', note: '测试盖流水' })
ok('显式执行才真盖', okResolve.ok === true)
const after = await parseFacts(DIR)
ok('盖章后是 superseded、行还在（不删行）', after.some((f) => f.content.includes('不喜欢喝咖啡') && f.status === 'superseded'))
ok('盖章记了原因', after.some((f) => f.status === 'superseded' && String(f.retractNote || '').includes('测试盖流水')))
ok('另一条还 active', after.some((f) => f.content.includes('喜欢喝咖啡') && f.status === 'active'))

await fs.rm(DIR, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
