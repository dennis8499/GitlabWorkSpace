import path from 'node:path';
import type { BmadCommandRequest, BmadWorkflowSnapshot } from './bmadProtocol';
import { BMAD_CAPABILITY_GUIDES } from './bmadGuide';

/** Constructs text for the clipboard. Commands are never sent to a shell. */
export function buildBmadCommand(snapshot: BmadWorkflowSnapshot, request: BmadCommandRequest): string {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.revision !== snapshot.revision) {
    throw new Error('BMAD 狀態已變更，請重新確認指令。');
  }
  const keys = new Set(['revision', 'command', 'skill', 'stepId', 'artifactId', 'storyId', 'requirement']);
  if (Object.keys(request).some(key => !keys.has(key)) || Object.values(request).some(value => value !== undefined && (typeof value !== 'string' || value.length > 8000 || value.includes('\0')))) {
    throw new Error('BMAD 指令格式無效。');
  }
  if (request.command === 'task') {
    if (request.skill || request.stepId || request.artifactId || request.storyId || !request.requirement?.trim()) throw new Error('請填寫本次需求。');
    if (!snapshot.root || !path.isAbsolute(snapshot.root) || snapshot.installation.state !== 'ready' ||
        snapshot.compatibility === 'unsupported' || snapshot.observation.state === 'error' || !snapshot.codex.skills.includes('bmad-help')) {
      throw new Error('BMAD 或 $bmad-help 尚未準備完成，請重新偵測。');
    }
    return ['$bmad-help', `工作根目錄：${snapshot.root}`, `BMAD 預設產出位置：${path.join(snapshot.root, '_bmad-output')}`,
      '請依以下需求與目前專案狀態，自行判斷適合的 BMAD 能力與流程，並在此工作根目錄處理：', request.requirement.trim()].join('\n\n');
  }
  if (request.command === 'codex') {
    if (request.skill || request.stepId || request.artifactId || request.storyId || request.requirement) throw new Error('此指令不接受工作參數。');
    return 'codex';
  }
  if (request.requirement !== undefined) throw new Error('此指令不接受需求文字。');
  if (request.command !== 'skill') throw new Error('不支援此 BMAD 指令。');
  const node = request.stepId ? snapshot.nodes.find(item => item.id === request.stepId)
    : snapshot.nodes.find(item => item.skill === request.skill);
  if (!node && !request.stepId && request.skill && Object.hasOwn(BMAD_CAPABILITY_GUIDES, request.skill) && !request.artifactId && !request.storyId) {
    return `$${request.skill}`;
  }
  if (!node || request.skill && request.skill !== node.skill || !/^bmad-[a-z0-9-]+$/.test(node.skill) ||
    node.action && !/^[a-zA-Z0-9_-]+$/.test(node.action)) throw new Error('找不到此 BMAD 能力，請重新選擇。');
  if (request.artifactId && request.storyId) throw new Error('請一次選擇一份工作紀錄。');
  let command = `$${node.skill}${node.action ? ` ${node.action}` : ''}`;
  const relative = (filename: string): string => {
    if (!snapshot.root || !path.isAbsolute(filename)) throw new Error('工作路徑無效。');
    const value = path.relative(snapshot.root, filename);
    if (path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) throw new Error('工作路徑超出目前專案。');
    return value.split(path.sep).join('/');
  };
  if (request.artifactId || request.storyId) {
    if (snapshot.observation.state === 'error' || snapshot.compatibility === 'unsupported') throw new Error('請先重新偵測目前的工作紀錄。');
    if (request.artifactId) {
      const artifact = snapshot.steps.find(step => step.id === node.id)?.artifacts.find(item => item.id === request.artifactId);
      if (!artifact) throw new Error('工作紀錄已不存在或不屬於此能力。');
      command += ` ${JSON.stringify(relative(artifact.path))}`;
    } else {
      const story = snapshot.stories.find(item => item.id === request.storyId);
      if (!story || !['bmad-build', 'bmad-code-review', 'bmad-help'].includes(node.skill)) throw new Error('Story 已不存在或不適用此能力。');
      if (node.skill !== 'bmad-help' && (story.status === 'conflict' || story.association === 'unconfirmed' || story.association === 'ambiguous')) {
        throw new Error('Story 對應尚未確認；請先使用 $bmad-help 核對。');
      }
      if (node.skill === 'bmad-build' && story.mode === 'spec' && story.inventoryPath) {
        relative(story.inventoryPath);
        const prefix = `${story.inventoryPath}#`;
        const id = story.id.startsWith(prefix) ? story.id.slice(prefix.length) : '';
        if (!id) throw new Error('找不到正式 Story 識別；請先使用 $bmad-help 核對。');
        command += ` spec_folder=${JSON.stringify(relative(path.dirname(story.inventoryPath)))} story_id=${JSON.stringify(id)}`;
      } else if (story.mode === 'classic') {
        const prefix = `${story.path}#`, id = story.id.startsWith(prefix) ? story.id.slice(prefix.length) : '';
        if (!id) throw new Error('找不到正式 Sprint Story 識別；請先使用 $bmad-help 核對。');
        command += ` Story ${JSON.stringify(id)} from ${JSON.stringify(relative(story.path))}`;
      } else command += ` ${JSON.stringify(relative(story.path))}`;
    }
  }
  return command;
}
