// audit-ux/ux-probe4.mjs — 自己改人格卡后，本会话会重新读到吗？
import { writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newStore, mount, head, show } from './harness.mjs'

const store = await newStore()
const m = await mount({ memoryDir: store })
await m.startup('startup')

head('G1 本会话用 relay_persona 更新人格卡')
show('relay_persona update', await m.call('relay_persona', {
  action: 'update',
  content: '# 人格卡\n\n## 我是谁\n- 名字：小鲸（新名字：鲸鲸二号）',
}))
const step1 = await m.preStep()
await new Promise((r) => setTimeout(r, 2200))
const step1b = await m.preStep()
show('下一步的提示消息数（等过 2 秒节流后）', String(step1b.messages?.length ?? 0))
show('提示内容', JSON.stringify(step1b.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('G2 主人从外面直接改 persona.md')
await appendFile(join(store, 'persona.md'), '\n## 追加\n- 主人说以后叫鲸鲸三号\n', 'utf8')
await new Promise((r) => setTimeout(r, 2200))
const step2 = await m.preStep()
show('下一步的提示', JSON.stringify(step2.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('G3 本会话写一条记忆后，下一步会不会重复推给自己')
await m.call('relay_remember', { content: '自写记忆不应重复推送。', source: 'owner' })
const step3 = await m.preStep()
show('下一步的提示', JSON.stringify(step3.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('G4 relay_status 的历史备份')
show('relay_status', await m.call('relay_status'))

await m.cleanup()
console.log('\n[done]')
