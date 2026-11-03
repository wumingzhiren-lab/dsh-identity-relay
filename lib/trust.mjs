// lib/trust.mjs — 来源可信度（动态）+ 记忆年龄标记（纯函数，脱离宿主可单测）
//
// 设计取舍（先查文献再定，2026-11-03）：
// 1) 不做「按衰减重排」。typed-decay 预印本（Zenodo 22643061）的结论是：
//    同类候选集里，按新鲜度排序和按显著度排序对任何有限半衰期都等价——
//    也就是说「重排」几乎改变不了结果，只会制造"看起来很智能"的假象。
// 2) 做「年龄标记」：超过 N 天没更新的记忆，注入时提醒一句。
//    信息价值在提示，不在把它排到后面。
// 3) 做「动态信任」：按**人工判错率**给来源降权。
//    关键区分：同键替换产生的 superseded 是正常演进（新事实取代旧事实），不算错；
//    只有 relay_retract（人认为记错了）才计入判错率。
//    参考 neural-context-protocol 的做法：降权有上限，不把来源一棍子打死。
//
// 动态信任分的计算放在 store.mjs（那儿有 SOURCE_RANK），这里只做统计与年龄判定，
// 避免两个模块互相 import 形成环。

/** 同键替换的作废原因（这类作废是正常演进，不算"说错"） */
const SUPERSEDE_NOTE = '被同键新记忆取代'

/**
 * 统计每个来源的写入数、作废数和**人工判错数**。
 * @returns {{[source: string]: {writes:number, superseded:number, manualRetract:number, retractRate:number}}}
 */
export function sourceTrustStats(facts) {
  const stats = {}
  for (const f of Array.isArray(facts) ? facts : []) {
    const s = String(f?.source || 'unknown')
    if (!stats[s]) stats[s] = { writes: 0, superseded: 0, manualRetract: 0, retractRate: 0 }
    const v = stats[s]
    v.writes++
    if (f.status === 'superseded' || f.status === 'archived') {
      v.superseded++
      const note = String(f.retractNote || '')
      // 同键替换不算判错；其余（relay_retract / 归档）算
      if (!note.includes(SUPERSEDE_NOTE)) v.manualRetract++
    }
  }
  for (const k of Object.keys(stats)) {
    stats[k].retractRate = stats[k].writes > 0 ? stats[k].manualRetract / stats[k].writes : 0
  }
  return stats
}

/** 这条记忆多久没更新了（毫秒）。时间解析不了返回 null。 */
export function ageMs(fact, now = Date.now()) {
  const t = Date.parse(String(fact?.time || ''))
  if (!Number.isFinite(t)) return null
  return Math.max(0, (Number(now) || Date.now()) - t)
}

/** 是否「很久没更新」：超过 staleDays 天。没有 time 或解析不了 → 不算旧（不误标）。 */
export function isStale(fact, { now = Date.now(), staleDays = 120 } = {}) {
  const age = ageMs(fact, now)
  if (age === null) return false
  return age >= Math.max(1, Number(staleDays) || 120) * 86400000
}
