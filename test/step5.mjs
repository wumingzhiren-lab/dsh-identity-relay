// step5.mjs — 关联记忆 + 归档 + 检索上限/来源优先 端到端测试（临时目录，不碰真实记忆库）
// 运行：node test/step5.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, readFacts, recallFacts, parseFacts, storeStats } from '../lib/store.mjs'

const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step5-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// 1) 关联：按内容片段挂到已有记忆
const rA = await appendFact(DIR, 'CTX1《我以为我记得》已发布抖音', { source: 'evidence', subject: 'CTX1' })
const rB = await appendFact(DIR, '补话题的方法：编辑作品→Input.insertText→点选下拉项', { source: 'evidence' })
const rC = await appendFact(DIR, 'CTX1 的数据：播放 139、赞 6', { source: 'evidence', related: ['CTX1《我以为我记得》已发布抖音', rB.entry.id] })
ok('related 写入两条', (rC.entry.related || []).length === 2)
ok('related 含作品那条的 id', (rC.entry.related || []).includes(rA.entry.id))
ok('related 含按 id 挂的那条', (rC.entry.related || []).includes(rB.entry.id))

// 2) 解析不到的关联：跳过并回报，不写入
const rD = await appendFact(DIR, '一条挂不上的记忆', { related: ['完全不存在的片段xyz'] })
ok('解析不到不写入 related', !rD.entry.related)
ok('解析不到会回报 unresolved', Array.isArray(rD.unresolved) && rD.unresolved.length === 1)

// 3) 回忆命中时带出关联（标 via=related），最多 3 条
const hit = await recallFacts(DIR, 'CTX1 的数据')
ok('命中主条', hit.some((f) => f.content.startsWith('CTX1 的数据')))
ok('带出关联条', hit.some((f) => f.via === 'related'))

// 4) 关联最多 3 条
const rE = await appendFact(DIR, '挂五条关联的主条', { related: ['CTX1《我以为我记得》已发布抖音', '补话题的方法', 'CTX1 的数据', '一条挂不上的记忆', rA.entry.id] })
const hitE = await recallFacts(DIR, '挂五条关联的主条')
ok('关联最多 3 条', hitE.filter((f) => f.via === 'related').length <= 3)
ok('主条自己也在结果里', hitE.some((f) => f.content === '挂五条关联的主条'))

// 5) 检索上限写死 20
for (let i = 0; i < 30; i++) await appendFact(DIR, `批量记忆 ${i}`, { source: 'tool' })
const capped = await recallFacts(DIR, '批量记忆', { limit: 100 })
ok('检索上限 20', capped.length === 20)

// 6) 来源优先：owner 排在 inferred 前
await appendFact(DIR, '优先级测试 主人原话', { source: 'owner' })
await appendFact(DIR, '优先级测试 我的推断', { source: 'inferred' })
const prio = await recallFacts(DIR, '优先级测试', { limit: 10 })
ok('owner 排第一', prio[0] && prio[0].content === '优先级测试 主人原话')

// 7) 归档：不参与读档/检索，但 parseFacts 还能看到
const toArchive = (await parseFacts(DIR)).find((f) => f.content === '批量记忆 0')
await appendFact(DIR, '归档占位（让文件重写）', { source: 'tool' })
const raw = (await fs.readFile(`${DIR}/facts.jsonl`, 'utf8')).split('\n').filter((l) => l.trim())
const marked = raw.map((line) => {
  const o = JSON.parse(line)
  if (o.id === toArchive.id) return JSON.stringify({ ...o, status: 'archived', archivedBy: 'test' })
  return line
})
await fs.writeFile(`${DIR}/facts.jsonl`, marked.join('\n') + '\n', 'utf8')
const after = await readFacts(DIR, { limit: 100 })
ok('readFacts 不含 archived', !after.some((f) => f.content === '批量记忆 0'))
ok('recall 不含 archived', !(await recallFacts(DIR, '批量记忆 0')).some((f) => f.content === '批量记忆 0'))
ok('parseFacts 仍看得到 archived 状态', (await parseFacts(DIR)).find((f) => f.content === '批量记忆 0').status === 'archived')
const st = await storeStats(DIR)
ok('storeStats 统计 archived', st.archivedCount === 1)
ok('storeStats active 不含 archived', st.activeCount === (await parseFacts(DIR)).filter((f) => f.status === 'active').length)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
