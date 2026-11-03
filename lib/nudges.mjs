// lib/nudges.mjs — pre-step 提示的决策逻辑（纯函数，脱离宿主可单测）
//
// 为什么单独抽出来：这些提示原本写在一个 handler 里，每个分支各自 return，
// 先命中的会把后面的吞掉（2026-11-03 真机才发现：档案提示吞掉了增量注入，
// 而且它早就在吞容量预警）。逻辑要能单测「多个条件同时命中时全都出」。

/** 上下文容量是否该预警（比例线 or 剩余绝对值，任一命中）。 */
export function shouldNudgeCapacity({ used, window, warnRatio, reserveTokens, lastNudgeAt, nudgeMs, now = Date.now() }) {
  if (!Number.isFinite(window) || window <= 0) return false
  const remaining = window - used
  const overRatio = used / window >= warnRatio
  const lowReserve = remaining <= reserveTokens
  if (!overRatio && !lowReserve) return false
  if (now - (Number(lastNudgeAt) || 0) < nudgeMs) return false
  return true
}

/** 档案更新提示是否该发（一分钟节流）。 */
export function shouldNudgeArchive({ changed, lastNudgeAt, nudgeMs, now = Date.now() }) {
  if (!Array.isArray(changed) || changed.length === 0) return false
  return now - (Number(lastNudgeAt) || 0) >= nudgeMs
}

/**
 * 把「这一步要发哪些提示」算出来，返回数组（每项 {kind, text}）。
 * 关键点：**所有条件独立判断、并列收集**——一个命中不影响另一个。
 */
export function planStepNudges({
  changed = [],
  freshFacts = [],
  capacity = null,
  archive = { due: false },
  now = Date.now(),
} = {}) {
  const out = []

  // 1) 新记忆：直接带进来
  if (Array.isArray(freshFacts) && freshFacts.length > 0) {
    out.push({ kind: 'fresh-facts', facts: freshFacts })
  }

  // 2) 档案更新（人格卡/交接书变了，光靠增量记忆补不回来）
  if (archive && archive.due) {
    out.push({ kind: 'archive-update', changed: changed.slice() })
  }

  // 3) 容量预警
  if (capacity && capacity.due) {
    out.push({ kind: 'capacity', used: capacity.used, window: capacity.window })
  }

  return out
}
