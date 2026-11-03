// step13.mjs — 0.5 并发写压测：进程内并发 + 跨进程并发都不许丢行
// 运行：node test/step13.mjs（从插件根目录）
// 只测不变量：行数不减、id 不重复、每行合法 JSON、锁最终被释放。
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFact, parseFacts, LOCK_FILE } from '../lib/store.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

const STORE_URL = new URL('../lib/store.mjs', import.meta.url).href
const dirs = []
const mkdir = async (tag) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `relay-${tag}-`))
  dirs.push(d)
  return d
}

/** 只读地校验一个库：行数、合法 JSON、id 唯一、内容集合。 */
async function inspect(dir) {
  const raw = await fs.readFile(path.join(dir, 'facts.jsonl'), 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  let bad = 0
  const ids = new Set()
  const dupIds = []
  const contents = []
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { bad++; continue }
    contents.push(row.content)
    if (row.id) { if (ids.has(row.id)) dupIds.push(row.id); ids.add(row.id) }
  }
  return { lines: lines.length, bad, dupIds, contents }
}

// ── 1) 进程内并发：一次 20 个写，一个都不能丢 ──
{
  const d = await mkdir('conc-in')
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendFact(d, `进程内并发 ${i}`, { source: 'tool' })))
  const r = await inspect(d)
  ok('进程内 20 并发：行数正好 20', r.lines === 20)
  ok('进程内 20 并发：没有坏行', r.bad === 0)
  ok('进程内 20 并发：id 全唯一', r.dupIds.length === 0 && r.lines > 0)
  ok('进程内 20 并发：内容集合完整', new Set(r.contents).size === 20)
  ok('进程内 20 并发：锁已释放', !(await fs.stat(path.join(d, LOCK_FILE)).catch(() => null)))
}

// ── 2) 跨进程并发：两个 node 进程同时各写 10 条（facts.lock 的正面测试）──
{
  const d = await mkdir('conc-xp')
  const childCode = `
    const { appendFact } = await import(${JSON.stringify(STORE_URL)});
    const [dir, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) await appendFact(dir, tag + '-' + i, { source: 'tool' });
  `
  const runChild = (tag, n) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', childCode, d, tag, String(n)], { stdio: 'ignore' })
    p.on('exit', (code) => resolve(code ?? 1))
  })
  const codes = await Promise.all([runChild('进程甲', 10), runChild('进程乙', 10)])
  ok('两个子进程都正常退出', codes.every((c) => c === 0))
  const r = await inspect(d)
  ok('跨进程 2x10：行数正好 20（没互相覆盖）', r.lines === 20)
  ok('跨进程 2x10：没有坏行', r.bad === 0)
  ok('跨进程 2x10：id 全唯一', r.dupIds.length === 0)
  ok('跨进程 2x10：两边的内容都在', (() => {
    const a = r.contents.filter((c) => c.startsWith('进程甲-')).length
    const b = r.contents.filter((c) => c.startsWith('进程乙-')).length
    return a === 10 && b === 10
  })())
  ok('跨进程 2x10：锁已释放', !(await fs.stat(path.join(d, LOCK_FILE)).catch(() => null)))
}

// ── 3) 三个进程一起上，再验一次（锁要有排队能力，不是两两碰运气）──
{
  const d = await mkdir('conc-xp3')
  const childCode = `
    const { appendFact } = await import(${JSON.stringify(STORE_URL)});
    const [dir, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) await appendFact(dir, tag + '-' + i, { source: 'tool' });
  `
  const runChild = (tag, n) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', childCode, d, tag, String(n)], { stdio: 'ignore' })
    p.on('exit', (code) => resolve(code ?? 1))
  })
  const codes = await Promise.all([runChild('甲', 6), runChild('乙', 6), runChild('丙', 6)])
  ok('三进程都正常退出', codes.every((c) => c === 0))
  const r = await inspect(d)
  ok('三进程 3x6：行数正好 18', r.lines === 18)
  ok('三进程 3x6：没有坏行、id 唯一', r.bad === 0 && r.dupIds.length === 0)
  const all = new Set(r.contents)
  ok('三进程 3x6：每家 6 条都在', ['甲', '乙', '丙'].every((t) => [...all].filter((c) => c.startsWith(t + '-')).length === 6))
}

// ── 4) 并发读不受写影响：写的同时读，不能读到半行 ──
{
  const d = await mkdir('conc-rw')
  await appendFact(d, '基线', { source: 'tool' })
  const writer = (async () => {
    for (let i = 0; i < 10; i++) await appendFact(d, `边写边读 ${i}`, { source: 'tool' })
  })()
  const reads = []
  for (let i = 0; i < 5; i++) reads.push((await parseFacts(d)).length)
  await writer
  const r = await inspect(d)
  ok('边写边读：读到的永远是整行（行数单调不减）', reads.every((n, i) => i === 0 || n >= reads[i - 1]))
  ok('边写边读：最后 11 行全在', r.lines === 11 && r.bad === 0)
}

await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
