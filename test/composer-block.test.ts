/**
 * Composer 停用原因的判斷順序 —— §10.6 / 憲法 7.1。
 *
 * ⚠️ 這支測試存在的理由：**「有沒有被擋下」很好驗，「擋下的理由對不對」不會**。
 *    M1 手動驗收時抓到判斷順序寫反 —— 未 JOIN 的對話被顯示成
 *    「全自動（唯讀）模式，任何人都無法送出訊息」，而客服其實只要按「加入對話」。
 *    typecheck、單元測試、smoke 全都是綠的，因為它們只驗到「送不出去」。
 *
 *    告訴客服**錯的理由**比不告訴他更糟：他會照著錯的理由去做錯的事
 *    （跑去找主管改模式，而不是按加入）。
 */

import { describe, expect, it } from 'vitest'
import { composerBlockReason } from '../app/utils/composer-block.js'
import { controlFromMode } from '../shared/types/conversation.js'

const ME = 'u_me'

describe('未加入對話', () => {
  it('mode 為 null（從未 JOIN）時應說「尚未加入」，不可說成「全自動唯讀」', () => {
    // ⚠️ 這正是被抓到的 bug：controlFromMode(null).agentCanSend 是 false，
    //    但那是「還沒加入」的結果，不是「對話被設成唯讀」的證據。
    const reason = composerBlockReason({
      control: controlFromMode(null),
      viewerJoined: false,
      myOperatorId: ME,
    })
    expect(reason).toEqual({ key: 'notJoined' })
  })

  it('對話真的是 automation、但我也還沒加入 → 仍優先提示「加入」（那才是可執行的動作）', () => {
    const reason = composerBlockReason({
      control: controlFromMode('automation'),
      viewerJoined: false,
      myOperatorId: ME,
    })
    expect(reason).toEqual({ key: 'notJoined' })
  })

  it('尚未載入 control 時也要說「尚未加入」，不可顯示成沒問題', () => {
    expect(composerBlockReason({ control: null, viewerJoined: false }))
      .toEqual({ key: 'notJoined' })
  })
})

describe('已加入', () => {
  it('manual → 可以送，不顯示任何阻擋', () => {
    expect(composerBlockReason({
      control: controlFromMode('manual'),
      viewerJoined: true,
      myOperatorId: ME,
    })).toBeNull()
  })

  it('hybrid → 可以送（AI 也會送，但那是撞單檢查的事）', () => {
    expect(composerBlockReason({
      control: controlFromMode('hybrid'),
      viewerJoined: true,
      myOperatorId: ME,
    })).toBeNull()
  })

  it('已加入但被切成 automation → 這時才是真的「全自動唯讀」', () => {
    // 同事在別處把模式切成 Automation Only，我方 Composer 也會被停用。
    // 這不是 bug，但畫面必須說清楚原因（§10.6）。
    expect(composerBlockReason({
      control: controlFromMode('automation'),
      viewerJoined: true,
      myOperatorId: ME,
    })).toEqual({ key: 'automation' })
  })
})

describe('主管強制介入（§10.6 唯一的真鎖）', () => {
  const lock = { by: 'u_boss', name: '林主管', at: '2026-08-25T00:00:00.000Z' }

  it('被別人鎖住時最優先顯示 —— 那是唯一「按加入也沒用」的情況', () => {
    expect(composerBlockReason({
      control: { ...controlFromMode('manual'), lock },
      viewerJoined: false,
      myOperatorId: ME,
    })).toEqual({ key: 'locked', name: '林主管' })
  })

  it('⚠️ 鎖是我自己上的時候不可擋我 —— 主管鎖了對話正是為了自己接手', () => {
    expect(composerBlockReason({
      control: { ...controlFromMode('manual'), lock: { ...lock, by: ME } },
      viewerJoined: true,
      myOperatorId: ME,
    })).toBeNull()
  })

  it('operatorId 的 u_ 前綴差異不可造成誤判', () => {
    // 訊息與鎖記的 id 帶 u_ 前綴，登入回應的 user_id 不保證帶 ——
    // 用 === 比會讓主管被自己的鎖擋在外面
    expect(composerBlockReason({
      control: { ...controlFromMode('manual'), lock: { ...lock, by: 'u_boss' } },
      viewerJoined: true,
      myOperatorId: 'boss',
    })).toBeNull()
  })
})
