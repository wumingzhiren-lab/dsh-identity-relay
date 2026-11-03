// 一次性数据清洗：修掉记忆内容末尾误写入的工具调用残留
// （形如 `...</content>\n<parameter name="source">tool`，是某次 relay_remember 参数格式出错写进去的）
// 先备份，再原子替换，最后逐行校验。
import fs from 'node:fs'

const DIR = 'C:/Users/admin/.dsh/identity-memory'
const P = DIR + '/facts.jsonl'
const raw = fs.readFileSync(P, 'utf8')
const backup = P + '.bak-20261103-1655'
fs.writeFileSync(backup, raw, 'utf8')

const lines = raw.split('\n')
const out = []
let fixed = 0
const fixedIds = []
for (const line of lines) {
  if (!line.trim()) { out.push(line); continue }
  let o
  try { o = JSON.parse(line) } catch { out.push(line); continue }
  if (typeof o.content === 'string' && o.content.includes('</content>')) {
    const cleaned = o.content.replace(/<\/content>[\s\S]*$/, '').trim()
    if (cleaned && cleaned !== o.content) {
      o.content = cleaned
      fixed++
      fixedIds.push(o.id || '(no id)')
      out.push(JSON.stringify(o))
      continue
    }
  }
  out.push(line)
}

if (fixed === 0) {
  console.log('没有需要清洗的行')
} else {
  const text = out.join('\n')
  const tmp = P + '.tmp-clean'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, P)
  console.log('清洗了 ' + fixed + ' 行，备份在 ' + backup)
  console.log('行 id：' + fixedIds.join(', '))
}

// 校验：行数、JSON 合法性、脏后缀是否清零
const after = fs.readFileSync(P, 'utf8')
const afterLines = after.split('\n').filter((l) => l.trim())
let bad = 0
let dirty = 0
for (const l of afterLines) {
  try {
    const o = JSON.parse(l)
    if (typeof o.content === 'string' && o.content.includes('</content>')) dirty++
  } catch { bad++ }
}
const beforeCount = lines.filter((l) => l.trim()).length
console.log('校验：行数 ' + beforeCount + ' -> ' + afterLines.length + '，坏行 ' + bad + '，残留脏后缀 ' + dirty)
