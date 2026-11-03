// step8.mjs — 记忆有效期（valid time）：过期的 active 记忆不占注入名额（临时目录）
// 运行：node test/step8.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, parseFacts, pickFactsForInjection, readExpiredFacts, isExpired, isNotYetValid, isEffective } from '../lib/store.mjs'

const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step8-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── isExpired 单元 ──
ok('没有 validTo = 永不过期', isExpired({ content: 'x' }) === false)
ok('validTo 在过去 = 过期', isExpired({ validTo: '2020-01-01T00:00:00.000Z' }) === true)
ok('validTo 在未来 = 没过期', isExpired({ validTo: '2099-01-01T00:00:00.000Z' }) === false)
ok('非法日期不炸、不判过期', isExpired({ validTo: '不是日期' }) === false)
ok('空对象不炸', isExpired(null) === false)

// ── 写入与读回 ──
const r1 = await appendFact(DIR, '主人这学期上大二', { source: 'owner', validFrom: '2026-09-01', validTo: '2027-07-01' })
ok('写入保留 validFrom', r1.entry.validFrom === '2026-09-01')
ok('写入保留 validTo', r1.entry.validTo === '2027-07-01')
const parsed = await parseFacts(DIR)
ok('读回保留 validFrom', parsed[0].validFrom === '2026-09-01')
ok('读回保留 validTo', parsed[0].validTo === '2027-07-01')

// ── 过期过滤 ──
await appendFact(DIR, '主人上学期是大一', { source: 'owner', validTo: '2026-06-30' })
await appendFact(DIR, '一条普通记忆', { source: 'tool' })
const injected = await pickFactsForInjection(DIR, { limit: 20 })
ok('过期的 active 不进注入', !injected.some((f) => f.content === '主人上学期是大一'))
ok('没填有效期的照常进注入', injected.some((f) => f.content === '一条普通记忆'))
ok('有效期还没到的照常进注入', injected.some((f) => f.content === '主人这学期上大二'))

// ── 过期列表 ──
const exp = await readExpiredFacts(DIR)
ok('已过期列表含那条', exp.some((f) => f.content === '主人上学期是大一'))
ok('已过期列表不含未过期的', !exp.some((f) => f.content === '一条普通记忆'))
const exp1 = await readExpiredFacts(DIR, { limit: 1 })
ok('过期列表 limit 生效', exp1.length === 1)

// ── 过期的 owner 也不占保底名额 ──
await appendFact(DIR, '主人的旧话（已过期）', { source: 'owner', validTo: '2020-01-01' })
const pin = await pickFactsForInjection(DIR, { limit: 5 })
ok('过期的 owner 不占保底名额', !pin.some((f) => f.content === '主人的旧话（已过期）'))

// ── 老数据（没有有效期的行）不受影响 ──
const oldLine = JSON.stringify({ time: '2020-01-01T00:00:00.000Z', content: '老记忆无有效期', source: 'tool', status: 'active' })
await fs.appendFile(DIR + '/facts.jsonl', oldLine + '\n', 'utf8')
const back = await pickFactsForInjection(DIR, { limit: 20 })
ok('无有效期的老数据照常注入', back.some((f) => f.content === '老记忆无有效期'))

// ── 过期但已作废的，不进过期列表（只列 active 的）──
const { retractFact } = await import('../lib/store.mjs')
await appendFact(DIR, '过期又作废的', { source: 'tool', validTo: '2020-01-01' })
await retractFact(DIR, '过期又作废的', { note: '测试' })
const exp2 = await readExpiredFacts(DIR)
ok('作废的不进过期列表', !exp2.some((f) => f.content === '过期又作废的'))

// ── 未生效（validFrom 在未来）同样不该进注入 ──
ok('validFrom 在未来 = 还没生效', isNotYetValid({ validFrom: '2099-01-01' }) === true)
ok('validFrom 在过去 = 已生效', isNotYetValid({ validFrom: '2020-01-01' }) === false)
ok('无 validFrom = 一直算成立', isNotYetValid({}) === false)
ok('isEffective：还没开始不算', isEffective({ validFrom: '2099-01-01' }) === false)
ok('isEffective：已过期不算', isEffective({ validTo: '2020-01-01' }) === false)
ok('isEffective：普通记忆算', isEffective({ content: 'x' }) === true)

await appendFact(DIR, '2027 年春季开始带计算机课', { source: 'owner', validFrom: '2027-03-01' })
const inj2 = await pickFactsForInjection(DIR, { limit: 20 })
ok('未到生效日的不进注入', !inj2.some((f) => f.content.startsWith('2027 年春季')))

// ── 同键替换给旧条补 validTo（历史链要连得上）──
await appendFact(DIR, '项目状态：进行中', { source: 'tool', subject: 'proj' })
await appendFact(DIR, '项目状态：已完成', { source: 'tool', subject: 'proj' })
const all2 = await parseFacts(DIR)
const oldProj = all2.find((f) => f.content === '项目状态：进行中')
ok('同键替换给旧条补了 validTo', !!oldProj && !!oldProj.validTo)
ok('旧条被盖章为 superseded', oldProj && oldProj.status === 'superseded')
ok('旧条的 validTo 等于新条写入时刻', oldProj && !isNaN(Date.parse(oldProj.validTo)))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
