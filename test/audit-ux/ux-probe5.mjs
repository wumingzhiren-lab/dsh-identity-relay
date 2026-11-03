// audit-ux/ux-probe5.mjs — README 配置表逐项核对（每项都真能生效吗）
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newStore, mount, head, show } from './harness.mjs'

const meter = (tokens) => ({ measure: () => ({ totalTokens: tokens }) })

head('H1 enabled=false：整个插件不加载')
const m0 = await mount({ memoryDir: await newStore(), config: { enabled: false } })
show('注册的工具数', String(m0.tools.size))

head('H2 alwaysOnSection')
const m1 = await mount({ memoryDir: await newStore() })
show('默认 anchor section 数', String(m1.sections.length))
const m1b = await mount({ memoryDir: await newStore(), config: { alwaysOnSection: false } })
show('关掉后 section 数', String(m1b.sections.length))

head('H3 injectOnResume / injectOnSubagents')
const m2 = await mount({ memoryDir: await newStore() })
show('默认 resume 注入长度', String((await m2.startup('resume')).length))
const m2b = await mount({ memoryDir: await newStore(), config: { injectOnResume: false } })
show('injectOnResume=false 的 resume 注入长度', String((await m2b.startup('resume')).length))
const m2c = await mount({ memoryDir: await newStore(), config: { injectOnSubagents: false } })
const subInjected = []
for (const h of m2c.handlers.get('agent/created') ?? []) {
  await h({
    agent: { id: 'sub-1', session: { header: { origin: 'subagent' } }, inject: (m) => subInjected.push(m) },
    source: 'startup',
  })
}
show('injectOnSubagents=false 时子代理注入条数', String(subInjected.length))
const m2d = await mount({ memoryDir: await newStore() })
const subInjected2 = []
for (const h of m2d.handlers.get('agent/created') ?? []) {
  await h({
    agent: { id: 'sub-2', session: { header: { origin: 'subagent' } }, inject: (m) => subInjected2.push(m) },
    source: 'startup',
  })
}
show('默认时子代理注入条数', String(subInjected2.length))

head('H4 maxInjectChars=500 / maxHandoverChars=500')
const store4 = await newStore()
const m4 = await mount({ memoryDir: store4, config: { maxInjectChars: 500, maxHandoverChars: 500 } })
await writeFile(join(store4, 'persona.md'), '人'.repeat(1200), 'utf8')
await writeFile(join(store4, 'handover.md'), '交'.repeat(1200), 'utf8')
const inj4 = await m4.startup('startup')
show('人格卡段有没有截断提示', inj4.includes('…（已截断，全文用 relay_load 重读）') ? '有' : '没有')
show('注入块长度', String(inj4.length))

head('H5 容量预警：warnRatio=0.7, contextWindow=65536')
const m5 = await mount({ memoryDir: await newStore(), services: { tokenMeter: meter(50000) } })
const s5 = await m5.preStep()
show('第一步提示', JSON.stringify(s5.messages?.map((x) => x.content?.[0]?.text) ?? []))
const s5b = await m5.preStep()
show('紧接着第二步（nudgeMinutes=10 应该不重复）', JSON.stringify(s5b.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('H6 reserveTokens=40000 单独触发（used=30000, 窗口 65536）')
const m6 = await mount({ memoryDir: await newStore(), services: { tokenMeter: meter(30000) } })
const s6 = await m6.preStep()
show('提示', JSON.stringify(s6.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('H7 maxFacts=150：写 160 条')
const store7 = await newStore()
const m7 = await mount({ memoryDir: store7, config: { maxFacts: 150 } })
for (let i = 0; i < 160; i++) await m7.call('relay_remember', { content: `流水 ${i}`, source: 'tool' })
const raw7 = (await readFile(join(store7, 'facts.jsonl'), 'utf8')).split('\n').filter(Boolean)
show('实际保留行数', String(raw7.length))
show('relay_status 条数', (await m7.call('relay_status')).split('\n').find((l) => l.includes('记忆条数')))

head('H8 pinMax=2 / pinWindow=10')
const store8 = await newStore()
const m8 = await mount({ memoryDir: store8, config: { pinMax: 2, pinWindow: 10 } })
await m8.call('relay_remember', { content: '主人原话 A', source: 'owner' })
await m8.call('relay_remember', { content: '主人原话 B', source: 'owner' })
for (let i = 0; i < 12; i++) await m8.call('relay_remember', { content: `流水 ${i}`, source: 'tool' })
const inj8 = await m8.startup('startup')
show('注入里 owner 条数', String((inj8.match(/\[owner\]/g) ?? []).length))

for (const x of [m0, m1, m1b, m2, m2b, m2c, m4, m5, m6, m7, m8]) await x.cleanup()
console.log('\n[done]')
