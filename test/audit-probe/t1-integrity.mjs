// audit-probe/t1-integrity.mjs — 顺序依赖 / 同键替换 × 去重 / 有效期链 的自洽性
import { parseFacts, isEffective, appendFact } from '../../lib/store.mjs'
import { newStore, mount, check, report, out } from './harness.mjs'

const A = async () => {
  const dir = await newStore()
  const h = await mount({ memoryDir: dir })
  return { dir, h }
}

// ── 1) 同键 + 完全相同内容：去重检查排在“压旧”之后 ──────────────────────────
{
  const { dir, h } = await A()
  const r1 = await h.call('relay_remember', { content: '主人喜欢猫', source: 'owner', subject: 'pet' })
  const r2 = await h.call('relay_remember', { content: '主人喜欢猫', source: 'owner', subject: 'pet' })
  const facts = await parseFacts(dir)
  const active = facts.filter((f) => f.status === 'active')
  check('T1-1 同键同内容重复写入后仍有 1 条 active', active.length === 1,
    `返回：${out(r2)}\n文件行：${facts.map((f) => f.status).join(',')}`)
  check('T1-1b 旧条的 supersededBy 指向真实存在的行',
    facts.every((f) => !f.supersededBy || facts.some((x) => x.id === f.supersededBy)),
    facts.map((f) => `${f.status} supersededBy=${f.supersededBy ?? '-'}`).join('\n'))
  // 用户视角：能不能再找回来？
  const recall = await h.call('relay_recall', { query: '猫' })
  check('T1-1c relay_recall 仍能检到这条记忆', recall.includes('主人喜欢猫'), recall)
  check('T1-1d relay_load 里仍有这条记忆',
    (await h.call('relay_load', {})).includes('主人喜欢猫'))
  await h.cleanup()
}

// ── 2) 同键换内容（正常演进）是否留下正确的历史链 ───────────────────────────
{
  const { dir, h } = await A()
  await h.call('relay_remember', { content: '版本A', source: 'owner', subject: 's1' })
  await new Promise((r) => setTimeout(r, 5))
  await h.call('relay_remember', { content: '版本B', source: 'owner', subject: 's1' })
  const facts = await parseFacts(dir)
  const old = facts.find((f) => f.content === '版本A')
  const neu = facts.find((f) => f.content === '版本B')
  check('T1-2 同键换内容：旧条 superseded、新条 active',
    old?.status === 'superseded' && neu?.status === 'active',
    facts.map((f) => `${f.status} ${f.content} validTo=${f.validTo ?? '-'}`).join('\n'))
  check('T1-2b 旧条被给了 validTo（SCD2 关区间）', !!old?.validTo, `validTo=${old?.validTo}`)
  check('T1-2c 旧条 supersededBy 指向新条', old?.supersededBy === neu?.id)
  await h.cleanup()
}

// ── 3) 先作废、再同键重新写入 ──────────────────────────────────────────────
{
  const { dir, h } = await A()
  await h.call('relay_remember', { content: '旧结论：要递申请', source: 'owner', subject: 'apply' })
  await h.call('relay_retract', { content: '旧结论', note: '记错了' })
  await h.call('relay_remember', { content: '新结论：不递申请', source: 'owner', subject: 'apply' })
  const facts = await parseFacts(dir)
  check('T1-3 作废后再写同键：只有 1 条 active 且是新结论',
    facts.filter((f) => f.status === 'active').length === 1 &&
    facts.find((f) => f.status === 'active')?.content.includes('不递申请'),
    facts.map((f) => `${f.status} ${f.content} note=${f.retractNote ?? '-'}`).join('\n'))
  const t = await h.call('relay_status', {})
  check('T1-3b relay_status 计数自洽（1 active / 1 作废）', /active 1/.test(t) && /已作废 1/.test(t), t)
  await h.cleanup()
}

// ── 4) 新条 validTo 已过期：会不会把旧条关掉、导致该键彻底无有效记忆 ─────────
{
  const { dir, h } = await A()
  await h.call('relay_remember', { content: '旧值：A', source: 'owner', subject: 'k' })
  const r = await h.call('relay_remember', { content: '新值：B', source: 'owner', subject: 'k', validTo: '2020-01-01' })
  const facts = await parseFacts(dir)
  const eff = facts.filter((f) => f.status === 'active' && isEffective(f))
  check('T1-4 写一条“已过期”的新值后，该键仍有有效记忆', eff.length >= 1,
    `有效记忆 ${eff.length} 条；${facts.map((f) => `${f.status} ${f.content} validTo=${f.validTo ?? '-'}`).join('\n')}\n工具返回：${out(r)}`)
  await h.cleanup()
}

// ── 5) validFrom 写错（非法日期）会让“压旧”失效吗 ──────────────────────────
{
  const dir = await newStore()
  await appendFact(dir, '值1', { source: 'owner', subject: 'k' })
  const r = await appendFact(dir, '值2', { source: 'owner', subject: 'k', validFrom: '不是日期' })
  const facts = await parseFacts(dir)
  const eff = facts.filter((f) => f.status === 'active' && isEffective(f))
  check('T1-5 非法 validFrom 写入了但没报错（写入口不校验）', r.appended === true && !!facts.find((f) => f.content === '值2')?.validFrom,
    `validFrom=${facts.find((f) => f.content === '值2')?.validFrom}`)
  check('T1-5b 非法 validFrom 没有让旧值继续“有效”', eff.length === 1,
    `有效记忆 ${eff.length} 条：${eff.map((f) => f.content).join('/')}；旧条 validTo=${facts.find((f) => f.content === '值1')?.validTo}`)
}

// ── 6) 有效期写错的情形：非法 validTo 当成“永不过期” ────────────────────────
{
  const dir = await newStore()
  await appendFact(dir, '到期写错的记忆', { source: 'owner', validTo: '2026-13-45' })
  const f = (await parseFacts(dir))[0]
  check('T1-6 非法 validTo 被静默当成永不过期', isEffective(f) === true, `validTo=${f.validTo} isEffective=${isEffective(f)}`)
}

report('T1 自洽性')
