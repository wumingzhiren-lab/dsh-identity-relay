// audit-probe/t3-lock-time.mjs — 锁残留 / 时钟回拨 / 时区混用 / 非法日期
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFact, parseFacts, findConflicts, recallFacts, isExpired, LOCK_FILE, FACTS_FILE } from '../../lib/store.mjs'
import { newStore, mount, check, report } from './harness.mjs'

const now = () => Date.now()

// ── 1) 崩溃残留锁：新鲜 mtime（刚崩 1 秒）→ 写入要等 5 秒再报错 ───────────
{
  const dir = await newStore()
  await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, time: new Date().toISOString() }))
  const t0 = now()
  let err = null
  try { await appendFact(dir, '崩溃后第一条', { source: 'owner' }) } catch (e) { err = e }
  const dt = now() - t0
  check('T3-1 崩溃残留锁（刚崩）会让写入失败', !!err,
    `${err && err.message}，耗时 ${dt}ms`)
  check('T3-2 失败信息里点出锁文件（可操作性）', !!err && /facts\.lock/.test(String(err.message)),
    String(err?.message))
  // 残留锁 30 秒后是否能自愈
  const old = new Date(Date.now() - 31000)
  await fs.utimes(join(dir, LOCK_FILE), old, old)
  const t1 = now()
  let ok = null
  try { ok = await appendFact(dir, '崩溃后第二条', { source: 'owner' }) } catch (e) { ok = e }
  check('T3-3 锁超过 30 秒后可被抢占（自愈）', ok?.appended === true, `${JSON.stringify(ok?.appended ?? ok?.message)}，耗时 ${now() - t1}ms`)
  check('T3-3b 抢占后没有残留锁文件',
    !(await fs.readdir(dir)).includes(LOCK_FILE), (await fs.readdir(dir)).join(','))
}

// ── 2) 时钟回拨 / 时间戳在未来的锁：永远“不陈旧”，写入永久失败 ───────────
{
  const dir = await newStore()
  const lockPath = join(dir, LOCK_FILE)
  await writeFile(lockPath, JSON.stringify({ pid: 1, time: '2026-11-03T00:00:00Z' }))
  const future = new Date(Date.now() + 6 * 3600 * 1000) // 系统时钟回拨前留下的锁
  await fs.utimes(lockPath, future, future)
  const t0 = now()
  let err = null
  try { await appendFact(dir, '时钟回拨时写入', { source: 'owner' }) } catch (e) { err = e }
  check('T3-4 未来 mtime 的锁被当作“正在使用”（写入失败）', !!err, `耗时 ${now() - t0}ms，${err?.message}`)
  const facts = await parseFacts(dir)
  check('T3-4b 读取仍正常（只有写被卡死）', Array.isArray(facts))
  // 5 分钟后再试还是失败吗？——只要 mtime 在未来就不会自愈
  const stillFuture = await fs.stat(lockPath).then((s) => s.mtimeMs > Date.now())
  check('T3-5 该锁在 mtime 到期前不会自愈（长达数小时不可写）', stillFuture)
}

// ── 3) 同进程并发写：全部保留 ─────────────────────────────────────────────
{
  const dir = await newStore()
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendFact(dir, `并发 ${i}`, { source: 'tool' })))
  const facts = await parseFacts(dir)
  check('T3-6 20 条同进程并发写入零丢失', facts.length === 20, `实际 ${facts.length}`)
  check('T3-7 并发后无残留 tmp 文件',
    !(await fs.readdir(dir)).some((n) => n.includes('.tmp-')), (await fs.readdir(dir)).join(','))
}

// ── 4) 崩溃残留 tmp 文件不影响读 ─────────────────────────────────────────
{
  const dir = await newStore()
  await appendFact(dir, '正常一条', { source: 'owner' })
  await writeFile(join(dir, `${FACTS_FILE}.tmp-12345`), '{"content":"半截写')
  const facts = await parseFacts(dir)
  check('T3-8 遗留 tmp 半截文件不影响解析', facts.length === 1)
}

// ── 5) 时区混用（手工/别的工具写入 +08:00）：排序与矛盾扫描窗口 ───────────
{
  const dir = await newStore()
  const row = (time, content, source = 'owner') =>
    JSON.stringify({ id: 'id-' + time, time, content, source, status: 'active' })
  await writeFile(join(dir, FACTS_FILE), [
    row('2026-11-03T09:00:00+08:00', '无关的旧事'),          // = 01:00Z（最旧）
    row('2026-11-03T07:30:00Z', '主人不喜欢咖啡'),           // 中间
    row('2026-11-03T08:00:00Z', '主人喜欢咖啡'),             // = 最近
  ].join('\n') + '\n')
  const recalled = await recallFacts(dir, '咖啡', { limit: 2 })
  check('T3-9 recall 按真实时间新→旧（最近的是 08:00Z 那条）',
    recalled[0]?.content === '主人喜欢咖啡',
    recalled.map((f) => `${f.time} ${f.content}`).join(' | '))
  const pairs = findConflicts(await parseFacts(dir), { scanLimit: 2 })
  check('T3-10 矛盾扫描“最近 2 条”窗口按真实时间取（应发现 1 对）',
    pairs.length === 1,
    `发现 ${pairs.length} 对；排序被字符串比较带偏 → 最近的那条被踢出窗口`)
}

// ── 6) 日期语义：validTo 只有日期时被当成 UTC 零点 ─────────────────────────
{
  const f = { content: 'x', validTo: '2026-11-03' }
  // 北京时间 2026-11-03 09:00（法律上 11-03 还没过完）
  const local0900 = Date.parse('2026-11-03T09:00:00+08:00')
  check('T3-11 validTo=2026-11-03 在本地当天 09:00 仍有效', isExpired(f, local0900) === false,
    `isExpired=${isExpired(f, local0900)}（UTC 零点 = 北京 08:00，提前 16 小时到期）`)
}

// ── 7) 工具层：锁被占用时 relay_remember 怎么反馈 ─────────────────────────
{
  const dir = await newStore()
  const h = await mount({ memoryDir: dir })
  const p = join(dir, LOCK_FILE)
  await writeFile(p, '{"pid":1}')
  const lockTime = new Date(Date.now() + 3600 * 1000)
  await fs.utimes(p, lockTime, lockTime)
  let res = null
  let err = null
  try { res = await h.call('relay_remember', { content: '被锁住时写的', source: 'owner' }) } catch (e) { err = e }
  check('T3-12 锁被占时工具层给出可读提示（而不是抛异常/卡 5 秒）',
    typeof res === 'string' && /锁|忙|重试/.test(res),
    err ? `抛出异常：${err.message}` : `返回：${res}`)
  await h.cleanup()
}

report('T3 锁与时间')
