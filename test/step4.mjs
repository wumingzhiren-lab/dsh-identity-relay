// step4.mjs — 来源与作废机制 + 凭据拦截 端到端测试（临时目录，不碰真实记忆库）
// 运行：node test/step4.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import { appendFact, readFacts, recallFacts, retractFact, parseFacts, looksLikeSecret } from '../lib/store.mjs'

const DIR = 'C:/Users/admin/AppData/Local/Temp/relay-step4-test'
await fs.rm(DIR, { recursive: true, force: true })
await fs.mkdir(DIR, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// 1) 老数据兼容：裸行 {time,content}
await fs.writeFile(`${DIR}/facts.jsonl`, JSON.stringify({ time: '2026-10-28T00:00:00Z', content: '老数据无字段' }) + '\n', 'utf8')
let parsed = await parseFacts(DIR)
ok('老行默认 source=unknown', parsed[0].source === 'unknown')
ok('老行默认 status=active', parsed[0].status === 'active')

// 2) appendFact 默认与带 source
await appendFact(DIR, '默认来源的记忆')
await appendFact(DIR, '主人亲口说的记忆', { source: 'owner', subject: 'CTX1' })
parsed = await parseFacts(DIR)
ok('默认 source=inferred', parsed.find((f) => f.content === '默认来源的记忆').source === 'inferred')
ok('显式 source=owner 生效', parsed.find((f) => f.content === '主人亲口说的记忆').source === 'owner')
ok('新条有 id', !!parsed.find((f) => f.content === '主人亲口说的记忆').id)

// 3) 同键新压旧：同 subject=CTX1 再写一条
await appendFact(DIR, 'CTX1 的新状态：已发布', { source: 'tool', subject: 'CTX1' })
parsed = await parseFacts(DIR)
const oldCtx = parsed.find((f) => f.content === '主人亲口说的记忆')
const newCtx = parsed.find((f) => f.content === 'CTX1 的新状态：已发布')
ok('同键旧条盖章 superseded', oldCtx.status === 'superseded')
ok('supersededBy 指向新条', oldCtx.supersededBy === newCtx.id)

// 4) readFacts 默认只出 active
const active = await readFacts(DIR, { limit: 20 })
ok('readFacts 不含 superseded', !active.some((f) => f.content === '主人亲口说的记忆'))
ok('readFacts 含新条', active.some((f) => f.content === 'CTX1 的新状态：已发布'))

// 5) recallFacts 翻案
const all = await recallFacts(DIR, 'CTX1', { limit: 10, all: true })
ok('all=true 能看到被作废的旧条', all.some((f) => f.status === 'superseded'))
const onlyActive = await recallFacts(DIR, 'CTX1', { limit: 10 })
ok('默认 recall 只有 active', onlyActive.every((f) => f.status !== 'superseded'))

// 6) retractFact 盖章 + 原因
const r = await retractFact(DIR, '默认来源的记忆', { note: '演示作废，内容记错了' })
ok('retract 找到并作废', r.found === true && r.entry.status === 'superseded')
ok('retract 原因写入', r.entry.retractNote === '演示作废，内容记错了')
const r2 = await retractFact(DIR, '默认来源的记忆', { note: '再试一次' })
ok('已作废的不会再命中', r2.found === false)

// 7) 重复写的行为：带 subject = 同键更新；不带 subject 的完全重复才拦
const again = await appendFact(DIR, 'CTX1 的新状态：已发布', { source: 'tool', subject: 'CTX1' })
ok('同 subject 重复写 = 更新（不是拦）', again.duplicated !== true && again.appended === true)
parsed = await parseFacts(DIR)
const supersededSame = parsed.filter((f) => f.content === 'CTX1 的新状态：已发布' && f.status === 'superseded')
ok('同键重复写后旧条被盖章', supersededSame.length >= 1)
const dupNoSubj = await appendFact(DIR, 'CTX1 的新状态：已发布', { source: 'tool' })
ok('不带 subject 的完全重复被拦', dupNoSubj.duplicated === true)
const dupOld = await appendFact(DIR, '主人亲口说的记忆', { source: 'owner' })
ok('superseded 的同内容不算重复（可再记）', dupOld.duplicated !== true)

// 8) 凭据拦截：looksLikeSecret 与 appendFact 拒绝
ok('sk- 开头的 key 被识别', looksLikeSecret('我的 key 是 sk-abcdefghijklmnop'))
ok('password: 赋值被识别', looksLikeSecret('服务器 password: hunter2x'))
ok('API_KEY= 被识别', looksLikeSecret('API_KEY = abcd1234efgh'))
ok('长 Bearer token 被识别', looksLikeSecret('Bearer token: abcdefghijklmnopqrstuvwx'))
ok('PEM 私钥被识别', looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----xxxx'))
ok('聊 token 概念不误伤', !looksLikeSecret('上下文用了 26 万 token，好贵'))
ok('说忘了密码不误伤', !looksLikeSecret('主人说密码忘了，要重置'))
const sec = await appendFact(DIR, 'sk-abcdefghijklmnop', { source: 'tool' })
ok('appendFact 拒绝明文 key 写入', sec.appended === false && /凭据/.test(sec.error))

await fs.rm(DIR, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
