// step12.mjs — 0.5 检索升级：切词 + 双字组覆盖率（子串匹配的补充，不是替代）
// 运行：node test/step12.mjs（从插件根目录）
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendFact, recallFacts, retractFact,
  splitQueryTerms, termMatchesText, matchesQuery,
} from '../lib/store.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// ── 切词 ──
ok('空格切词', splitQueryTerms('主人 咖啡').join('|') === '主人|咖啡')
ok('中英文标点都切', splitQueryTerms('主人，咖啡、茶；牛奶').join('|') === '主人|咖啡|茶|牛奶')
ok('大小写归一', splitQueryTerms('CTX1 Data').join('|') === 'ctx1|data')
ok('空查询切成零个词', splitQueryTerms('   ').length === 0)
ok('null 不崩', splitQueryTerms(null).length === 0)

// ── 单词命中 ──
ok('整词子串命中', termMatchesText('抹茶', '主人喜欢抹茶') === true)
ok('两字词只靠子串（一个双字组没有余量）', termMatchesText('抹茶', '主人喜欢喝抹茶水') === true && termMatchesText('抹茶', '抹着茶') === false)
ok('覆盖率命中：主人喜欢什么 → 主人喜欢喝咖啡', termMatchesText('主人喜欢什么', '主人喜欢喝咖啡') === true)
ok('不相关不命中', termMatchesText('主人喜欢什么', '主人今天很忙') === false)
ok('单字词只靠子串', termMatchesText('猫', '养了一只猫') === true && termMatchesText('猫', '养了一只狗') === false)
ok('英文大小写不敏感（调用前已 lowercase）', termMatchesText('ctx1', 'ctx1 数据') === true)
ok('空词永不命中', termMatchesText('', '任何文本') === false && termMatchesText('x', '') === false)

// ── 多词是「与」 ──
ok('多词全中才命中', matchesQuery({ content: '主人喜欢喝咖啡' }, ['主人', '咖啡']) === true)
ok('差一个词就不命中', matchesQuery({ content: '主人喜欢喝咖啡' }, ['主人', '火锅']) === false)
ok('subject 也参与命中', matchesQuery({ content: '无关正文', subject: '咖啡偏好' }, ['咖啡']) === true)
ok('空词表不命中', matchesQuery({ content: '随便' }, []) === false)

// ── 真库路径集成 ──
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-step12-'))
await appendFact(DIR, '主人喜欢喝咖啡，不加糖', { source: 'owner' })
await appendFact(DIR, '主人今天很忙，在研究', { source: 'tool' })
await appendFact(DIR, '主人喜欢抹茶', { source: 'owner' })

const a = await recallFacts(DIR, '主人喜欢什么')
ok('「主人喜欢什么」能找到「主人喜欢喝咖啡」', a.some((f) => f.content.includes('喝咖啡')))
ok('「主人喜欢什么」也能找到「主人喜欢抹茶」', a.some((f) => f.content.includes('抹茶')))
ok('「主人喜欢什么」不把「很忙」算命中', !a.some((f) => f.content.includes('很忙')))

const b = await recallFacts(DIR, '火锅')
ok('未命中仍是空（没被放宽成乱匹配）', b.length === 0)

const c = await recallFacts(DIR, '主人 咖啡')
ok('多词查询命中', c.length === 1 && c[0].content.includes('喝咖啡'))

const d = await recallFacts(DIR, '主人 火锅')
ok('多词差一个 → 空', d.length === 0)

const e = await recallFacts(DIR, '抹茶')
ok('两字词回归：仍按子串命中', e.length === 1 && e[0].content.includes('抹茶'))

// ── 空查询 = 最近条目（按时间，不按来源）──
const f = await recallFacts(DIR, '', { limit: 2 })
ok('空查询按时间给最近 2 条', f.length === 2 && f[0].content.includes('抹茶') && f[1].content.includes('很忙'))

// ── 作废条目默认不出现 ──
await retractFact(DIR, '研究', { note: '测试判错' })
const g = await recallFacts(DIR, '主人')
ok('作废条目默认不再被召回', !g.some((x) => x.content.includes('很忙')))
const h = await recallFacts(DIR, '主人', { all: true })
ok('all:true 仍能看到作废条目', h.some((x) => x.content.includes('很忙')))

await fs.rm(DIR, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
