import { createHash } from 'node:crypto';
import type { DeliveryPreview } from './workspaceProtocol';

export interface DeliveryGateInput {
  workId: string;
  headSha: string;
  baseSha: string;
  localTargetSha: string;
  cloudTargetSha: string;
  status: string;
  diffSha256: string;
  acceptanceConfirmed: boolean;
}

/** Read-only Megin handoff gate. It pins the accepted working diff to a live branch base. */
export function evaluateMeginDeliveryGate(input: DeliveryGateInput): DeliveryPreview['gate'] {
  const reasons: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.workId)) reasons.push('Megin Work ID 格式無效。');
  if (!input.acceptanceConfirmed) reasons.push('尚未確認已由 Megin 完成人工驗收。');
  if (!input.headSha || !input.baseSha) reasons.push('無法確認 Megin 驗收時的 HEAD 與分支基底。');
  if (input.localTargetSha !== input.cloudTargetSha) reasons.push('本機目標分支未包含 GitLab 最新提交；請先 Fetch 並重新確認 Megin 驗收。');
  if (!input.diffSha256 || input.diffSha256 === createHash('sha256').update('').digest('hex')) reasons.push('目前沒有可交付的程式差異。');
  if (input.status.includes('??')) reasons.push('工作樹有尚未追蹤的檔案；請先由 Megin 納入驗收再預覽。');
  if (input.status.split(/\r?\n/).some((line) => line && line[0] !== ' ' && line[0] !== '?')) {
    reasons.push('暫存區已有內容；請保留現場並確認其是否屬於 Megin 驗收範圍。');
  }
  return { ok: reasons.length === 0, reasons };
}
