// audit-ux/ux-probe.mjs — 按「第一次用的人」的顺序走真实工具返回。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newStore, mount, head, show } from './harness.mjs'

const store = await newStore()
const m = await mount({ memoryDir: store })

// ---------- A. 装好之后第一步 ----------
head('A1 首次开工注入（模板刚生成，主人什么都还没写）')
const first = await m.startup('startup')
show('agent/created 注入块（原文）', first)

head('A2 新手第一次该跑的工具：relay_status')
show('relay_status', await m.call('relay_status'))

head('A3 失忆自救：relay_load（空库）')
show('relay_load', await m.call('relay_load'))

head('A4 读交接书 / 读人格卡')
show('relay_handover read', await m.call('relay_handover', { action: 'read' }))
show('relay_persona read', await m.call('relay_persona', { action: 'read' }))

// ---------- B. 正常路径 ----------
head('B1 记一条正常记忆（带来源 + subject）')
show('remember 1', await m.call('relay_remember', {
  content: '主人喜欢喝咖啡，不加糖。',
  source: 'owner',
  subject: '主人-饮品偏好',
}))
show('remember 2', await m.call('relay_remember', {
  content: '2026-11-03 首日播放 139。',
  source: 'evidence',
  subject: '作品-系统任务-首日',
}))

head('B2 用户搞错了：重复记同一条')
show('remember duplicate', await m.call('relay_remember', {
  content: '主人喜欢喝咖啡，不加糖。',
  source: 'owner',
}))

head('B3 用户搞错了：记太长（4001 字符）')
show('remember 4001', await m.call('relay_remember', { content: 'x'.repeat(4001), source: 'owner' }))

head('B4 用户搞错了：有效日期写成人话')
show('remember validTo="明年七月"', await m.call('relay_remember', {
  content: '主人这学期上大二。',
  source: 'owner',
  subject: '主人-年级',
  validTo: '明年七月',
}))

head('B5 用户搞错了：validFrom 写成"下个月"')
show('remember validFrom="下个月"', await m.call('relay_remember', {
  content: '主人下个月开始学日语。',
  source: 'owner',
  validFrom: '下个月',
}))

head('B6 用户搞错了：related 填了不存在的内容')
show('remember related=乱填', await m.call('relay_remember', {
  content: '关联测试。',
  source: 'self',
  related: ['完全不存在的片段'],
}))

head('B7 用户搞错了：source 传了不存在的档位')
show('remember source="boss"', await m.call('relay_remember', {
  content: '来源写错的测试。',
  source: 'boss',
}))

head('B8 回忆：命中 / 查不到 / 空查询 / 翻案')
show('recall 命中', await m.call('relay_recall', { query: '咖啡' }))
show('recall 查不到', await m.call('relay_recall', { query: '量子力学' }))
show('recall 空查询', await m.call('relay_recall', {}))
show('recall includeSuperseded', await m.call('relay_recall', { query: '咖啡', includeSuperseded: true }))

head('B9 作废：正常 / 查不到 / 忘了写原因')
show('retract 正常（写原因）', await m.call('relay_retract', {
  content: '首日播放 139',
  note: '数据记错了，实际 193。',
}))
show('retract 查不到', await m.call('relay_retract', { content: '根本没有这句', note: 'x' }))
show('retract 忘写原因', await m.call('relay_retract', { content: '关联测试' }))

head('B10 矛盾检测：空库 / 有矛盾')
const m2 = await mount({ memoryDir: await newStore() })
show('conflicts 空库', await m2.call('relay_conflicts'))
await m2.call('relay_remember', { content: '主人喜欢喝咖啡。', source: 'owner' })
await m2.call('relay_remember', { content: '主人讨厌喝咖啡。', source: 'owner' })
show('conflicts 一对矛盾', await m2.call('relay_conflicts'))

head('B11 交接书：写 / 读 / 空内容')
show('handover write', await m.call('relay_handover', {
  action: 'write',
  content: '# 交接书\n\n## 我是谁\n- 小鲸\n\n## 接下来\n- 等主人回家',
}))
show('handover read', await m.call('relay_handover', { action: 'read' }))
show('handover 空内容写', await m.call('relay_handover', { action: 'write', content: '   ' }))

head('B12 人格卡：更新 / 读 / 空内容')
show('persona update', await m.call('relay_persona', {
  action: 'update',
  content: '# 人格卡\n\n## 我是谁\n- 名字：小鲸',
}))
show('persona read', await m.call('relay_persona', { action: 'read' }))
show('persona 空内容', await m.call('relay_persona', { action: 'update', content: '' }))

head('B13 relay_load 传 0 / 999')
show('load factsLimit=0', await m.call('relay_load', { factsLimit: 0 }))
show('load factsLimit=999', (await m.call('relay_load', { factsLimit: 999 })).slice(0, 400) + '……')

// ---------- C. 配置真的生效吗 ----------
head('C1 配置越界：warnRatio=0.3 / recallLimit=200 / maxFacts=50')
const m3 = await mount({ memoryDir: await newStore(), config: { warnRatio: 0.3, recallLimit: 200, maxFacts: 50 } })
show('relay_status（看它报告的配置值）', await m3.call('relay_status'))

head('C2 关掉自动注入：injectOnCreated=false')
const m4 = await mount({ memoryDir: await newStore(), config: { injectOnCreated: false } })
show('startup 注入条数', String((await m4.startup('startup')) === '' ? 0 : 1))

head('C3 保底名额：23 条 tool 流水后，一条 300 条前的 owner 原话还在不在')
const store5 = await newStore()
const m5 = await mount({ memoryDir: store5 })
await m5.call('relay_remember', { content: '主人说：换会话不是换鱼，还是同一个你。', source: 'owner' })
for (let i = 0; i < 23; i++) {
  await m5.call('relay_remember', { content: `流水 ${i}：今天看了第 ${i} 条视频。`, source: 'tool' })
}
const injectPinned = await m5.startup('startup')
show('注入块里有没有 owner 原话', injectPinned.includes('换会话不是换鱼') ? '有' : '没有')
const m5b = await mount({ memoryDir: store5, config: { pinSources: [] } })
const injectNoPin = await m5b.startup('startup')
show('pinSources=[] 时还有没有', injectNoPin.includes('换会话不是换鱼') ? '有' : '没有')

// ---------- D. 文件层面（只读） ----------
head('D1 相对 memoryDir 落到哪（相对 home，不是相对当前目录）')
const m6 = await mount({ memoryDir: 'AppData/Local/Temp/relay-ux-relative-test' })
show('relay_status 目录', (await m6.call('relay_status')).split('\n')[0])

head('D2 facts.jsonl 里时间长什么样（新手手改文件时会看到）')
const factsRaw = await readFile(join(store, 'facts.jsonl'), 'utf8').catch(() => '')
show('facts.jsonl 前两行', factsRaw.split('\n').slice(0, 2).join('\n'))

await m.cleanup(); await m2.cleanup(); await m3.cleanup(); await m4.cleanup(); await m5.cleanup(); await m5b.cleanup(); await m6.cleanup()
const { homedir } = await import('node:os')
await import('node:fs/promises').then((fsp) => fsp.rm(join(homedir(), 'AppData/Local/Temp/relay-ux-relative-test'), { recursive: true, force: true })).catch(() => {})
console.log('\n[done]')
