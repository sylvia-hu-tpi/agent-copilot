/**
 * Spike 執行框架：環境載入、client 建立、findings 蒐集、fixture 落地。
 *
 * 設計意圖：每支 probe 只負責「問一個問題並記錄證據」，
 * 其餘（認證、輸出格式、遮蔽）全部由這裡處理。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImbraceClient, Environment } from '@imbrace/sdk'
import { clientForApiKey, clientForSession } from '../../../server/services/imbrace.js'
import { scrubObject } from '../../../server/utils/redact.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../../..')
export const OUT_DIR = resolve(ROOT, 'scripts/spike/out')

// ── 環境 ────────────────────────────────────────────────────

let envLoaded = false
export function loadEnv(): void {
  if (envLoaded) return
  for (const f of ['.env.local', '.env']) {
    const p = resolve(ROOT, f)
    if (existsSync(p)) {
      // Node >= 20.12 內建，不需 dotenv
      process.loadEnvFile(p)
      break
    }
  }
  envLoaded = true
}

export function env(key: string, fallback = ''): string {
  loadEnv()
  return process.env[key]?.trim() || fallback
}

export function requireEnv(key: string): string {
  const v = env(key)
  if (!v) throw new SkipProbe(`缺少環境變數 ${key}（見 .env.example）`)
  return v
}

/** 條件不足時中止該支 probe，但不算失敗 */
export class SkipProbe extends Error {}

/** 此檔是否被直接執行（Windows 路徑安全） */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(fileURLToPath(importMetaUrl)) === resolve(entry)
}

// ── Client ──────────────────────────────────────────────────

export function makeClient(): ImbraceClient {
  loadEnv()
  const e = (env('IMBRACE_ENV', 'sandbox')) as Environment
  const token = env('IMBRACE_ACCESS_TOKEN')
  const apiKey = env('IMBRACE_API_KEY')
  const orgId = env('IMBRACE_ORGANIZATION_ID') || undefined

  if (token) return clientForSession({ accessToken: token, organizationId: orgId }, { env: e })
  if (apiKey) return clientForApiKey(apiKey, { organizationId: orgId, env: e })
  throw new SkipProbe('需要 IMBRACE_ACCESS_TOKEN 或 IMBRACE_API_KEY（先跑 npm run spike:auth）')
}

// ── Findings ────────────────────────────────────────────────

export type Verdict = 'yes' | 'no' | 'partial' | 'unknown'

export interface Finding {
  /** 對應 IMBRACE_QUESTIONS.md 的編號，如 'H-3' */
  question: string
  claim: string
  verdict: Verdict
  evidence: string
  /** 對架構的影響 —— 這才是 spike 真正的產出 */
  impact?: string
}

const VERDICT_ICON: Record<Verdict, string> = {
  yes: '✅', no: '❌', partial: '🟡', unknown: '❓',
}

export class Probe {
  readonly findings: Finding[] = []
  constructor(readonly id: string, readonly title: string) {}

  record(f: Finding): void {
    this.findings.push(f)
    console.log(`  ${VERDICT_ICON[f.verdict]} [${f.question}] ${f.claim}`)
    console.log(`     └ ${f.evidence}`)
  }

  /** 存下已遮蔽的樣本 —— 這些會變成 M2 的 mock 資料與單元測試 fixture */
  fixture(name: string, data: unknown, raw = false): void {
    mkdirSync(OUT_DIR, { recursive: true })
    const payload = raw ? data : scrubObject(data)
    const file = resolve(OUT_DIR, `${this.id}-${name}.json`)
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    console.log(`     📁 ${file.replace(ROOT, '.')}`)
  }
}

/** 每支 probe 的統一進入點：處理 skip、錯誤、結果落地 */
export async function runProbe(
  id: string,
  title: string,
  fn: (p: Probe, c: ImbraceClient) => Promise<void>,
): Promise<Finding[]> {
  const probe = new Probe(id, title)
  console.log(`\n── ${id} ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`)
  try {
    await fn(probe, makeClient())
  } catch (err) {
    if (err instanceof SkipProbe) {
      console.log(`  ⏭  略過：${err.message}`)
      probe.record({
        question: id, claim: title, verdict: 'unknown',
        evidence: `未執行 —— ${err.message}`,
      })
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  💥 錯誤：${msg}`)
      probe.record({
        question: id, claim: title, verdict: 'unknown',
        evidence: `呼叫失敗 —— ${msg}`,
        impact: '本身即是發現：此 API 在當前憑證／環境下不可用',
      })
    }
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    resolve(OUT_DIR, `${id}-findings.json`),
    JSON.stringify(probe.findings, null, 2), 'utf8',
  )
  return probe.findings
}

/** 把所有 findings 合成一份可直接貼進 docs 的 markdown */
export function writeReport(all: Finding[]): string {
  const rows = all.map(f =>
    `| ${f.question} | ${f.claim} | ${VERDICT_ICON[f.verdict]} ${f.verdict} | ${f.evidence.replace(/\|/g, '\\|')} |`,
  ).join('\n')

  const impacts = all.filter(f => f.impact).map(f =>
    `### ${f.question} — ${f.claim}\n\n${f.impact}\n`,
  ).join('\n')

  const md = `# Spike 結果：iMBrace SDK 實測

> 產生時間：${new Date().toISOString()}
> 環境：\`${env('IMBRACE_ENV', 'sandbox')}\` ｜ SDK：\`@imbrace/sdk\`

## 結論總表

| 題號 | 待驗證事項 | 結果 | 證據 |
|---|---|---|---|
${rows}

## 對架構的影響

${impacts || '（無）'}

---
> 由 \`npm run spike\` 產生。原始樣本見 \`scripts/spike/out/\`（已遮蔽 PII）。
`
  mkdirSync(OUT_DIR, { recursive: true })
  const file = resolve(OUT_DIR, 'SPIKE_RESULT.md')
  writeFileSync(file, md, 'utf8')
  return file
}
