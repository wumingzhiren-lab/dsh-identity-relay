/**
 * 冒烟测试：直接在 Node 里验证记忆库层（lib/store.mjs）。
 * 运行：node identity-relay/plugin/test/smoke.mjs
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureStore, readTextSafe, readFacts, recallFacts, appendFact,
  writeStoreFile, storeStats, PERSONA_FILE, HANDOVER_FILE, FACTS_FILE,
} from '../lib/store.mjs'

let failed = 0
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}

const dir = await mkdtemp(join(tmpdir(), 'identity-relay-smoke-'))
try {
  // 1. ensureStore 自动建文件
  await ensureStore(dir)
  const persona = await readTextSafe(join(dir, PERSONA_FILE))
  check('persona.md 模板自动生成', persona.includes('人格卡'))
  const handover = await readTextSafe(join(dir, HANDOVER_FILE))
  check('handover.md 模板自动生成', handover.includes('交接书'))

  // 2. 记忆追加 + 去重
  const r1 = await appendFact(dir, '主人喜欢抹茶味的蛋糕', { maxFacts: 2000 })
  check('第一次记住成功', r1.appended === true)
  const r2 = await appendFact(dir, '主人喜欢抹茶味的蛋糕', { maxFacts: 2000 })
  check('重复内容去重', r2.appended === false && r2.duplicated === true)
  await appendFact(dir, '答应过周六一起看海', { maxFacts: 2000 })

  // 3. 读取与回忆
  const recent = await readFacts(dir, { limit: 10 })
  check('readFacts 最新在前', recent.length === 2 && recent[0].content === '答应过周六一起看海')
  const hit = await recallFacts(dir, '抹茶', { limit: 5 })
  check('recallFacts 关键词命中', hit.length === 1 && hit[0].content.includes('抹茶'))
  const miss = await recallFacts(dir, '火锅', { limit: 5 })
  check('recallFacts 未命中返回空', miss.length === 0)

  // 4. 交接书与人格卡写入
  await writeStoreFile(dir, HANDOVER_FILE, '# 交接\n- 在看海攻略')
  const ho = await readTextSafe(join(dir, HANDOVER_FILE))
  check('交接书可写可读', ho.includes('看海攻略'))
  await writeStoreFile(dir, PERSONA_FILE, '# 人格\n- 傲娇')
  const po = await readTextSafe(join(dir, PERSONA_FILE))
  check('人格卡可写可读', po.includes('傲娇'))

  // 5. 状态
  const stats = await storeStats(dir)
  check('storeStats 计数正确', stats.factCount === 2 && typeof stats[PERSONA_FILE].bytes === 'number')
  const raw = await readFile(join(dir, FACTS_FILE), 'utf8')
  check('jsonl 每行合法 JSON', raw.trim().split('\n').every((l) => { try { JSON.parse(l); return true } catch { return false } }))

  // 6. 坏行容错
  await writeStoreFile(dir, FACTS_FILE, raw + '\n{broken line\n')
  const tolerant = await readFacts(dir, { limit: 10 })
  check('坏行跳过不炸', tolerant.length === 2)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')
