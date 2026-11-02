// step6.mjs — 读档注入选取：主人/自己说过的话保底名额（临时目录，不碰真实记忆库）
// 运行：node test/step6.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, pickFactsForInjection, readFacts, retractFact } from '../lib/store.mjs'

const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step6-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }
const keyOf = (f) => f.id || String(f.time) + '|' + f.content

// 1) 空库
ok('空库返回空', (await pickFactsForInjection(DIR)).length === 0)

// 2) 主人的话最先写，后面堆 11 条流水把它挤出「最近 5 条」
await appendFact(DIR, '主人原话：别熬夜', { source: 'owner' })
for (let i = 0; i < 11; i++) await appendFact(DIR, `流水 ${i}`, { source: 'tool' })

// 3) 对照组：纯时间选取确实挤掉了它（证明后面的效果不是碰巧）
const plain = await readFacts(DIR, { limit: 5 })
ok('纯时间选取挤掉主人原话', !plain.some((f) => f.content === '主人原话：别熬夜'))

// 4) 注入选取把它捞回来，且排第一
const picked = await pickFactsForInjection(DIR, { limit: 5 })
ok('注入选取捞回主人原话', picked.some((f) => f.content === '主人原话：别熬夜'))
ok('主人原话排第一位', picked[0] && picked[0].content === '主人原话：别熬夜')
ok('总数不超过 limit', picked.length === 5)
ok('无重复', new Set(picked.map(keyOf)).size === picked.length)

// 5) 默认 pinMax = ceil(limit/3)
const picked8 = await pickFactsForInjection(DIR, { limit: 8 })
ok('默认保底名额在 ceil(8/3)=3 以内', picked8.filter((f) => f.source === 'owner').length <= 3)

// 6) 关掉保底（空数组）退回纯时间
const off = await pickFactsForInjection(DIR, { limit: 5, pinSources: [] })
ok('关闭保底后不含主人原话', !off.some((f) => f.content === '主人原话：别熬夜'))

// 7) 窗口外的不捞
const narrow = await pickFactsForInjection(DIR, { limit: 5, pinWindow: 3 })
ok('保底窗口外不捞', !narrow.some((f) => f.content === '主人原话：别熬夜'))

// 8) 作废的不参与
await appendFact(DIR, '另一条主人原话（将被作废）', { source: 'owner' })
await retractFact(DIR, '另一条主人原话（将被作废）', { note: '测试作废' })
const afterRetract = await pickFactsForInjection(DIR, { limit: 5 })
ok('作废的保底记忆不参与', !afterRetract.some((f) => f.content.startsWith('另一条主人原话')))

// 9) 没有 id 的老数据：不重复、也能被保底
const oldLine = JSON.stringify({ time: '2020-01-01T00:00:00.000Z', content: '老记忆：主人是学生', source: 'owner', status: 'active' })
await fs.appendFile(DIR + '/facts.jsonl', oldLine + '\n', 'utf8')
const withOld = await pickFactsForInjection(DIR, { limit: 5 })
ok('无 id 老数据被保底捞回', withOld.some((f) => f.content === '老记忆：主人是学生'))
ok('无 id 老数据不重复', withOld.filter((f) => f.content === '老记忆：主人是学生').length === 1)

// 10) limit 大于库存时全给，不报错
const allIn = await pickFactsForInjection(DIR, { limit: 500 })
ok('limit 超库存时全给', allIn.length === (await readFacts(DIR, { limit: 1000 })).length)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
