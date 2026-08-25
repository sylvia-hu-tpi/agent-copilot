/**
 * 一次跑完所有 probe 並產出 SPIKE_RESULT.md。
 *   npm run spike
 *
 * 注意：00-auth 是互動式的，不包含在此，請先單獨執行：
 *   npm run spike:auth
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeReport, OUT_DIR, type Finding } from './lib/harness.js'
import { probe01 } from './01-sender-type.js'
import { probe02 } from './02-multimodal.js'
import { probe03 } from './03-incremental.js'
import { probe04 } from './04-knowledge.js'
import { probe05 } from './05-ai-structured.js'

async function main() {
  console.log('═══ AgentCopilot Spike ═══')
  console.log('目的：把 docs/ARCHITECTURE.md §19 的未定事項，從假設變成事實。\n')

  const all: Finding[] = []

  // 00-auth 若已跑過，把它的 findings 一併納入報告
  const authFile = resolve(OUT_DIR, '00-auth-findings.json')
  if (existsSync(authFile)) {
    all.push(...JSON.parse(readFileSync(authFile, 'utf8')) as Finding[])
    console.log('（已納入先前 npm run spike:auth 的結果）')
  }

  for (const probe of [probe01, probe02, probe03, probe04, probe05]) {
    all.push(...await probe())
  }

  const file = writeReport(all)

  // ── 摘要 ─────────────────────────────────────────────
  const count = (v: string) => all.filter(f => f.verdict === v).length
  console.log(`\n═══ 總結 ═══`)
  console.log(`✅ ${count('yes')} 項確認可行 ｜ 🟡 ${count('partial')} 項部分可行 ｜ `
    + `❌ ${count('no')} 項不可行 ｜ ❓ ${count('unknown')} 項未能驗證`)

  const blockers = all.filter(f => f.verdict === 'no' && f.impact?.includes('❗'))
  if (blockers.length) {
    console.log(`\n🔴 需要立即決策的阻塞項：`)
    blockers.forEach(b => console.log(`   • [${b.question}] ${b.claim}`))
  }

  const unknowns = all.filter(f => f.verdict === 'unknown')
  if (unknowns.length) {
    console.log(`\n❓ 未能驗證（多半是測試資料不足，換個對話重跑即可）：`)
    unknowns.forEach(u => console.log(`   • [${u.question}] ${u.evidence}`))
  }

  console.log(`\n📄 完整報告：${file}`)
  console.log(`   下一步：把結論回填 docs/ARCHITECTURE.md §19 與 docs/IMBRACE_QUESTIONS.md，`)
  console.log(`   仍為 ❓/❌ 的項目就是真正需要問 iMBrace 的（清單已大幅縮短）。`)
}

main().catch(err => { console.error('\n💥', err); process.exit(1) })
