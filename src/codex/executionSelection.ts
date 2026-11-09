import type * as VSCode from 'vscode';
import { createHash } from 'node:crypto';
import type { Model } from './generated/v2/Model';
import type { CodexExecutionSelection, CodexTaskSource, CodexTaskSpec } from './protocol';
import { autoEfforts, routingModel, routingEfforts, selectRoutingEffort, validModelEfforts } from './modelRoutingProtocol';

export function validateExecutionSelection(selection: CodexExecutionSelection): void {
  if (selection.model !== undefined && (typeof selection.model !== 'string' || !selection.model.trim() || selection.model.length > 200 || [...selection.model].some(char => char.charCodeAt(0) < 32)) ||
      selection.effort !== undefined && (typeof selection.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(selection.effort)) ||
      selection.modelEfforts !== undefined && !validModelEfforts(selection.modelEfforts) ||
      !selection.model && (selection.effort !== undefined || selection.modelEfforts !== undefined)) throw new Error('模型或思考強度設定無效。');
}

/** Called once after the environment preparation; selections are part of its immutable identity. */
export function applyExecutionSelection(spec: CodexTaskSpec, source: CodexTaskSource): CodexTaskSpec {
  validateExecutionSelection(source);
  if (spec.review && source.model && source.model !== routingModel && !spec.routing?.supportsModelSelection) throw new Error('請更新 WorkflowKit，以使用其他審查模型。');
  if (source.effort === 'auto' && !spec.routing) throw new Error('Auto 思考強度僅適用於審查路由。');
  spec.source = structuredClone(source);
  spec.model = source.model; spec.effort = source.effort;
  if (spec.routing && source.model) {
    if (!spec.routing.supportsModelSelection && (source.model !== routingModel || source.modelEfforts)) throw new Error('請更新 WorkflowKit，以使用其他審查模型。');
    if (source.model !== routingModel && !source.modelEfforts) throw new Error('審查模型缺少已確認的思考強度，請重新建立任務。');
    if (source.modelEfforts) {
      if (source.effort === 'auto') selectRoutingEffort('high', source.modelEfforts);
      else if (!source.effort || !source.modelEfforts.includes(source.effort)) throw new Error('所選模型不支援此思考強度。');
      spec.routing = { ...spec.routing, model: source.model, supportedEfforts: [...source.modelEfforts] };
    }
    spec.routing.requestedEffort = source.effort ?? spec.routing.requestedEffort;
  }
  // Preserve pre-selection keys for legacy tasks so their saved identity remains resumable.
  if (source.kind !== 'free' && (source.model !== undefined || source.effort !== undefined)) {
    spec.environmentKey = createHash('sha256').update(JSON.stringify([spec.environmentKey, source.model, source.effort, source.modelEfforts])).digest('hex');
  }
  return spec;
}

export async function pickExecutionSelection(vscode: typeof VSCode, models: Model[], spec: CodexTaskSpec): Promise<CodexExecutionSelection | undefined> {
  if (!models.length) throw new Error('Codex 未提供可選模型，請核對登入與模型設定。');
  const routed = !!spec.routing;
  const review = routed || !!spec.review;
  const preferred = spec.model ?? spec.routing?.model ?? (review ? routingModel : undefined);
  const choices = models.map(model => ({ label: model.displayName, description: model.model, model }));
  const inherited = { label: '沿用本機 Codex 設定', description: '模型與思考強度沿用本機設定', model: undefined };
  const items = review ? choices : [inherited, ...choices];
  items.sort((a, b) => Number((b.model?.model) === preferred) - Number((a.model?.model) === preferred));
  if (!items.length) throw new Error('Codex 未提供可選模型，請核對登入與模型設定。');
  const selected = await vscode.window.showQuickPick(items, { title: '建立 Codex 任務：選擇模型', ignoreFocusOut: true });
  if (!selected) return undefined;
  if (!selected.model) return {};
  const model = selected.model;
  if (review && !spec.routing?.supportsModelSelection && model.model !== routingModel) throw new Error('請更新 WorkflowKit，以使用其他審查模型。');
  const catalogEfforts = model.supportedReasoningEfforts.filter(item => !routed || spec.routing!.supportsModelSelection || (routingEfforts as readonly string[]).includes(item.reasoningEffort));
  const supported = catalogEfforts.map(item => item.reasoningEffort);
  const canAuto = supported.length > 0 && autoEfforts(supported).length === supported.length;
  const preferredEffort = routed ? spec.effort ?? spec.routing!.requestedEffort : spec.model === model.model ? spec.effort ?? model.defaultReasoningEffort : model.defaultReasoningEffort;
  const efforts = catalogEfforts.map(item => ({ label: item.reasoningEffort, description: item.description }));
  if (routed && canAuto) efforts.unshift({ label: 'auto', description: '依固定證據判斷強度，最高使用此模型的上限' });
  if (!efforts.length) {
    if (routed) throw new Error('此模型未提供可用思考強度，無法執行審查路由。');
    return { model: model.model };
  }
  efforts.sort((a, b) => Number(b.label === preferredEffort) - Number(a.label === preferredEffort));
  const effort = await vscode.window.showQuickPick(efforts, { title: '建立 Codex 任務：選擇思考強度', ignoreFocusOut: true,
    placeHolder: routed && !canAuto ? '此模型的強度無法排序，請手動選擇；Auto 不可用' : undefined });
  if (!effort) return undefined;
  return { model: model.model, effort: effort.label, ...(routed && spec.routing!.supportsModelSelection ? { modelEfforts: supported } : {}) };
}
