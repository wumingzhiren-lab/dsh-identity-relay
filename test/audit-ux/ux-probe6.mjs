// audit-ux/ux-probe6.mjs — 全新库第一次 pre-step 会不会误报「有人刚写了」
import { newStore, mount, head, show } from './harness.mjs'

head('I1 全新库：装上后第一次 pre-step')
const store = await newStore()
const m1 = await mount({ memoryDir: store })
await new Promise((r) => setTimeout(r, 1000))
const s1 = await m1.preStep()
show('提示', JSON.stringify(s1.messages?.map((x) => x.content?.[0]?.text) ?? []))

head('I2 同一个库重新挂载（文件已存在）再 pre-step')
const m2 = await mount({ memoryDir: store })
await new Promise((r) => setTimeout(r, 1000))
const s2 = await m2.preStep()
show('提示', JSON.stringify(s2.messages?.map((x) => x.content?.[0]?.text) ?? []))

await m1.cleanup(); await m2.cleanup()
console.log('\n[done]')
