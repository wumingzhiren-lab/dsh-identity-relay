// audit-ux/ux-probe3.mjs — 失败路径：目录不可用 / 锁被占 / 同键重复
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newStore, mount, head, show } from './harness.mjs'

head('F1 memoryDir 写错（父路径是个文件）')
const base = await mkdtemp(join(tmpdir(), 'relay-ux-bad-'))
const filePath = join(base, 'blocker')
await writeFile(filePath, 'x')
const badDir = join(filePath, 'sub')
const mb = await mount({ memoryDir: badDir })
show('relay_status', await mb.call('relay_status'))
show('relay_remember', await mb.call('relay_remember', { content: '测试', source: 'owner' }))
show('relay_handover write', await mb.call('relay_handover', { action: 'write', content: '# x' }))
show('relay_recall', await mb.call('relay_recall', {}))

head('F2 锁被别的进程占着（同 pid 模拟“进程还活着”）')
const store = await newStore()
const m = await mount({ memoryDir: store })
await writeFile(join(store, 'facts.lock'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }))
const t0 = Date.now()
show('relay_remember（应等 5s 后报错）', await m.call('relay_remember', { content: '锁测试', source: 'owner' }))
console.log(`[耗时 ${Date.now() - t0} ms]`)
await import('node:fs/promises').then((f) => f.rm(join(store, 'facts.lock'), { force: true }))

head('F3 同键写同内容：会怎样？')
const m3 = await mount({ memoryDir: await newStore() })
show('第一次带 subject', await m3.call('relay_remember', { content: '作品 A 已发布。', source: 'tool', subject: '作品A' }))
show('第二次同 subject 同内容', await m3.call('relay_remember', { content: '作品 A 已发布。', source: 'tool', subject: '作品A' }))
show('不传 subject 的重复', await m3.call('relay_remember', { content: '作品 A 已发布。', source: 'tool' }))
show('recall 翻案看', await m3.call('relay_recall', { query: '作品 A', includeSuperseded: true }))
show('relay_status', await m3.call('relay_status'))

await mb.cleanup(); await m.cleanup(); await m3.cleanup()
await import('node:fs/promises').then((f) => f.rm(base, { recursive: true, force: true }))
console.log('\n[done]')
