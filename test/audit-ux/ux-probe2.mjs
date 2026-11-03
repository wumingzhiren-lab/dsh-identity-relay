// audit-ux/ux-probe2.mjs — 有效期在「回忆/读档」里到底算不算数
import { newStore, mount, head, show } from './harness.mjs'

const store = await newStore()
const m = await mount({ memoryDir: store })

head('E1 写一条「已经过期」的记忆（没给 subject，所以允许写）')
show('remember validTo=2020-01-01', await m.call('relay_remember', {
  content: '主人这学期上大一。',
  source: 'owner',
  validTo: '2020-01-01',
}))

head('E2 写一条「还没生效」的记忆')
show('remember validFrom=2030-01-01', await m.call('relay_remember', {
  content: '主人 2030 年毕业。',
  source: 'owner',
  validFrom: '2030-01-01',
}))

head('E3 新会话注入：这两条进不进来？（文档说：不占名额、单独列已过期）')
const inj = await m.startup('startup')
console.log(inj.includes('主人这学期上大一。') ? '[注入] 过期的那条出现在正文' : '[注入] 过期的那条没进正文')
console.log(inj.includes('主人 2030 年毕业。') ? '[注入] 未生效的那条出现在正文' : '[注入] 未生效的那条没进正文')
show('注入块尾部', inj.split('\n').slice(-12).join('\n'))

head('E4 但 relay_load 怎么说？')
const load = await m.call('relay_load')
show('relay_load 记忆段', load.split('── 最近记忆')[1] ?? load)

head('E5 那 relay_recall 呢？')
show('recall 空查询', await m.call('relay_recall', {}))
show('recall query=大', await m.call('relay_recall', { query: '大' }))

head('E6 作废原因能不能在翻案时看到？')
await m.call('relay_remember', { content: '主人说不用回这条评论。', source: 'owner' })
await m.call('relay_retract', { content: '不用回这条评论', note: '主人后来改口了，要回。' })
show('recall includeSuperseded', await m.call('relay_recall', { query: '评论', includeSuperseded: true }))

head('E7 作废一条后 relay_status 能看到什么')
show('relay_status', await m.call('relay_status'))

await m.cleanup()
console.log('\n[done]')
