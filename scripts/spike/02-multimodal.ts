/**
 * 02 — 語音／圖片是否已由平台文字化（H-2）🔴 P0
 *
 * 為何重要：這一題直接決定 M2 的工作量級距。
 *   平台已文字化 → 直接取用，AI 管線單純
 *   平台未文字化 → 需自建 STT + vision，M2 +5~10 人日，且成本模型完全改變
 *
 * 靜態分析已知（@imbrace/sdk@1.4.0）：
 *   MessageType = 'text'|'image'|'quick_reply'|'file'|'pdf'  ← 沒有 audio
 *   MessageContent = { text?, url?, caption?, title?, payload? }  ← 沒有 transcript
 * 因此預期答案是「未文字化」。本 probe 用真實資料確認，並找出語音訊息實際的載體。
 */

import { runProbe, requireEnv, isMain, type Finding } from './lib/harness.js'
import { tryStrategies } from '../../server/sources/message-fetch.js'
import { detectAttachmentKind } from '../../server/sources/mappers.js'

/** 平台若有做文字化，欄位可能不在型別定義中 —— 從原始 JSON 掃描可疑鍵名 */
const TRANSCRIPT_HINTS = /transcript|stt|speech|caption_ai|description|ocr|alt_text|summary|recogni/i

function findHiddenKeys(obj: unknown, path = '', out: string[] = []): string[] {
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const full = path ? `${path}.${k}` : k
    if (TRANSCRIPT_HINTS.test(k)) out.push(`${full} = ${JSON.stringify(v)?.slice(0, 80)}`)
    if (v && typeof v === 'object') findHiddenKeys(v, full, out)
  }
  return out
}

export const probe02 = () => runProbe('02', 'H-2 語音／圖片文字化', async (p, client) => {
  const convId = requireEnv('SPIKE_CONVERSATION_ID')

  const results = await tryStrategies(client, convId)
  const best = results.filter(r => r.messages.length > 0).sort((a, b) => b.precision - a.precision)[0]
  if (!best) throw new Error('取不到訊息')

  const nonText = best.messages.filter(m => m.type !== 'text' && m.type !== 'quick_reply')
  const byType = best.messages.reduce<Record<string, number>>(
    (a, m) => { a[m.type] = (a[m.type] ?? 0) + 1; return a }, {},
  )
  console.log(`     訊息型別分佈：${JSON.stringify(byType)}`)

  if (nonText.length === 0) {
    p.record({
      question: 'H-2', claim: '語音／圖片是否已文字化',
      verdict: 'unknown',
      evidence: `此對話 ${best.messages.length} 則訊息全為純文字，無附件可驗證`,
      impact: '⚠️ 必須換一個「確實含圖片與語音」的對話重跑，否則 M2 的工作量級距無法收斂。',
    })
    return
  }

  p.fixture('attachment-messages', nonText)

  // ① 型別定義外的隱藏欄位
  const hidden = [...new Set(nonText.flatMap(m => findHiddenKeys(m)))]

  // ② 語音訊息落在哪個 type
  // ⚠️ 不能用 detectAttachmentKind 判語音 —— `Attachment.kind` 已無 'audio'
  //    （平台不支援語音訊息，H-2a／H-2e）。此處直接嗅副檔名，才問得出
  //    「真的完全沒有語音樣本嗎」這個問題，而不是被我方型別先過濾掉。
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|amr|caf)$/i
  const audioLike = nonText.filter(m => AUDIO_EXT.test(m.content?.url ?? ''))
  const imageLike = nonText.filter(m => detectAttachmentKind(m.type, m.content?.url) === 'image')

  // ③ 附件是否附帶可用文字
  const withText = nonText.filter(m => (m.content?.text ?? '').trim().length > 0)
  const withCaption = nonText.filter(m => (m.content?.caption ?? '').trim().length > 0)

  console.log(`     附件 ${nonText.length} 則：疑似語音 ${audioLike.length}、圖片 ${imageLike.length}`)
  console.log(`     帶 text 的 ${withText.length} 則、帶 caption 的 ${withCaption.length} 則`)
  if (hidden.length) console.log(`     ⚠️ 發現型別定義外的可疑欄位：\n       ${hidden.join('\n       ')}`)

  p.record({
    question: 'H-2a', claim: '平台是否隨 message 回傳轉錄／描述文字',
    verdict: hidden.length > 0 ? 'partial' : 'no',
    evidence: hidden.length > 0
      ? `原始 JSON 出現疑似欄位：${hidden.slice(0, 3).join('; ')}`
      : `${nonText.length} 則附件訊息中，除 text/caption 外未見任何轉錄或描述欄位`,
    impact: hidden.length > 0
      ? '需人工確認這些欄位的語意與填充率，可能可直接取用。'
      : '❗ 平台未提供文字化 → M2 必須自建 STT 與圖片描述。'
        + '影響：+5~10 人日、需選定並接入 STT/vision 供應商、'
        + '§11.4 的「文字化結果必須快取」變成硬需求（否則成本失控）、'
        + '且對話內容出境的合規問題（風險 #9）範圍擴大到語音與影像。',
  })

  p.record({
    question: 'H-2b', claim: '語音訊息以何種 type 回傳',
    verdict: audioLike.length > 0 ? 'yes' : 'unknown',
    evidence: audioLike.length > 0
      ? `${audioLike.length} 則，SDK type=${[...new Set(audioLike.map(m => m.type))].join('/')}（MessageType 型別中無 audio，靠副檔名嗅探）`
      : '此對話未發現語音訊息',
    impact: audioLike.length > 0
      ? 'mappers.detectAttachmentKind 的副檔名嗅探邏輯有效，M1 可沿用。'
      : undefined,
  })

  p.record({
    question: 'H-2c', claim: '附件 URL 是否可直接存取（是否有時效）',
    verdict: nonText.some(m => m.content?.url) ? 'partial' : 'unknown',
    evidence: `附件以 ${nonText.filter(m => m.content?.url).length}/${nonText.length} 帶 url 形式回傳`,
    impact: '若 URL 有時效，自建 STT/vision 必須在收到訊息當下就處理並快取，不能延後。',
  })
})

if (isMain(import.meta.url)) {
  probe02().then((f: Finding[]) => process.exit(0))
}
