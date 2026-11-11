import type * as VSCode from 'vscode';
import { createHash } from 'node:crypto';
import type { Model } from './generated/v2/Model';
import type { CodexExecutionSelection, CodexTaskSource, CodexTaskSpec } from './protocol';
import { routingModel, validModelEfforts } from './modelRoutingProtocol';

export function validateExecutionSelection(selection: CodexExecutionSelection): void {
  if (selection.model !== undefined && (typeof selection.model !== 'string' || !selection.model.trim() || selection.model.length > 200 || [...selection.model].some(char => char.charCodeAt(0) < 32)) ||
      selection.effort !== undefined && (typeof selection.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(selection.effort)) ||
      selection.modelEfforts !== undefined && !validModelEfforts(selection.modelEfforts) ||
      !selection.model && (selection.effort !== undefined || selection.modelEfforts !== undefined)) throw new Error('模型或思考強度設定無效。');
}

/** Called once after the environment preparation; selections are part of its immutable identity. */
export function applyExecutionSelection(spec: CodexTaskSpec, source: CodexTaskSource): CodexTaskSpec {
  validateExecutionSelection(source);
  if (source.effort === 'auto') throw new Error('Auto 已移除，請選擇固定思考強度。');
  spec.source = structuredClone(source);
  spec.model = source.model; spec.effort = source.effort;
  // Preserve pre-selection keys for legacy tasks so their saved identity remains resumable.
  if (source.kind !== 'free' && (source.model !== undefined || source.effort !== undefined)) {
    spec.environmentKey = createHash('sha256').update(JSON.stringify([spec.environmentKey, source.model, source.effort, source.modelEfforts])).digest('hex');
  }
  return spec;
}

export async function pickExecutionSelection(vscode: typeof VSCode, models: Model[], spec: CodexTaskSpec): Promise<CodexExecutionSelection | undefined> {
  if (!models.length) throw new Error('Codex 未提供可選模型，請核對登入與模型設定。');
  const review = !!spec.review;
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
  const catalogEfforts = model.supportedReasoningEfforts;
  const preferredEffort = spec.model === model.model ? spec.effort ?? model.defaultReasoningEffort : model.defaultReasoningEffort;
  const efforts = catalogEfforts.map(item => ({ label: item.reasoningEffort, description: item.description }));
  if (!efforts.length) {
    return { model: model.model };
  }
  efforts.sort((a, b) => Number(b.label === preferredEffort) - Number(a.label === preferredEffort));
  const effort = await vscode.window.showQuickPick(efforts, { title: '建立 Codex 任務：選擇思考強度', ignoreFocusOut: true,
    placeHolder: '本次審查使用固定強度' });
  if (!effort) return undefined;
  return { model: model.model, effort: effort.label };
}
