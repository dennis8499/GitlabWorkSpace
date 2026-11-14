import path from 'node:path';
import type { BmadCommandRequest, BmadWorkflowSnapshot } from './bmadProtocol';
import type { WorkflowKitRunnerBinding } from './reviewSessionProtocol';
import { BMAD_CAPABILITY_GUIDES } from './bmadGuide';
import { bmadAutoBuildIssue, bmadRequestSkill } from './bmadEntrypoints';

/** Constructs text for the clipboard. Commands are never sent to a shell. */
export function buildBmadCommand(snapshot: BmadWorkflowSnapshot, request: BmadCommandRequest,
  runner?: WorkflowKitRunnerBinding): string {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.revision !== snapshot.revision) {
    throw new Error('BMAD 狀態已變更，請重新確認指令。');
  }
  const keys = new Set(['revision', 'command', 'skill', 'stepId', 'artifactId', 'storyId', 'requirement', 'entry', 'operation', 'nativeSkill']);
  if (Object.keys(request).some(key => !keys.has(key)) || Object.values(request).some(value => value !== undefined && (typeof value !== 'string' || value.length > 8000 || value.includes('\0')))) {
    throw new Error('BMAD 指令格式無效。');
  }
  const withRunner = (prompt: string): string => runner
    ? `${prompt}\n\n使用上述 WorkflowKit runner 執行 BMAD 或其他已安裝 Skill 的 Python、Node.js、uv helper；保留原工作目錄與 helper 參數。Runner 格式：python -X utf8 -B ${JSON.stringify(runner.script_path)} -- <原執行檔及參數>。`
    : prompt;
  if (request.command === 'entry') {
    if (request.skill || request.stepId || !snapshot.root || !path.isAbsolute(snapshot.root) || snapshot.installation.state !== 'ready' ||
        snapshot.compatibility === 'unsupported' || snapshot.observation.state === 'error' || request.operation && !['start', 'resume', 'status'].includes(request.operation)) {
      throw new Error('BMAD 入口或專案狀態尚未準備完成，請重新偵測。');
    }
    const router = bmadRequestSkill(snapshot, request);
    if ((!request.operation || request.operation === 'start') && !request.requirement?.trim()) throw new Error('請填寫本次需求。');
    if (request.artifactId && request.storyId) throw new Error('請一次選擇一份工作紀錄。');
    const artifact = request.artifactId ? snapshot.steps.flatMap(step => step.artifacts).find(item => item.id === request.artifactId) : undefined;
    const story = request.storyId ? snapshot.stories.find(item => item.id === request.storyId) : undefined;
    if (request.artifactId && !artifact || request.storyId && !story) throw new Error('工作紀錄已不存在，請重新偵測。');
    const selected = artifact?.path ?? story?.path;
    if (selected && ![snapshot.root, ...(snapshot.persistedArtifactRoots ?? [])].some(root => within(root, selected))) throw new Error('工作路徑超出目前專案與已驗證成果。');
    const operation = request.operation ?? 'start';
    const autoArtifact = artifact && snapshot.steps.some(step => snapshot.nodes.find(node => node.id === step.id)?.skill === 'bmad-build-auto' && step.artifacts.some(item => item.id === artifact.id));
    if (request.nativeSkill === 'bmad-build-auto' && (artifact?.nativeStatus === 'blocked' || story?.status === 'blocked') ||
        request.entry === 'build' && autoArtifact && artifact.nativeStatus === 'blocked') throw new Error('Build Auto 已受阻；請先透過智慧入口核對原因，不直接重派。');
    return withRunner([`$${router}`, `工作根目錄：${snapshot.root}`, `BMAD 預設產出位置：${path.join(snapshot.root, '_bmad-output')}`,
      `入口：${request.entry}；操作：${operation}`,
      request.nativeSkill ? `本次明確選擇能力：$${request.nativeSkill}。只載入此能力與目前階段必要參考。` : '依本次需求只選目前需要的一項原生能力，不預先載入全部候選。',
      selected ? `已核對工作紀錄：${JSON.stringify(selected)}${story ? `；Story：${JSON.stringify(story.id)}` : ''}` :
        operation === 'resume' ? '先依已保存紀錄讓使用者選擇要接續的工作，保留其原生能力與精確識別。' :
          operation === 'status' ? '只讀取進度與建議下一步；不啟動實作或遠端交付。' : '',
      autoArtifact && artifact.nativeStatus === 'blocked' ? '此 Build Auto 記錄已 blocked；先核對阻擋原因，未解決前不重派或改用其他實作流程重跑。' :
        autoArtifact && artifact.nativeStatus === 'done' ? '此 Build Auto 記錄已 done；再次派送只進原生 follow-up review，不當作一般 resume。' : '',
      request.requirement?.trim() ?? '',
      '專案規則修改先產生差異，確認後才套回原 Group／Repo；Push、開 Issue、發布 Wiki／報告與建立 MR 由 Host 取得本次成果確認後執行。'].filter(Boolean).join('\n\n'));
  }
  if (request.entry || request.operation || request.nativeSkill) throw new Error('此指令不接受入口參數。');
  if (request.command === 'task') {
    if (request.skill || request.stepId || request.artifactId || request.storyId || !request.requirement?.trim()) throw new Error('請填寫本次需求。');
    if (!snapshot.root || !path.isAbsolute(snapshot.root) || snapshot.installation.state !== 'ready' ||
        snapshot.compatibility === 'unsupported' || snapshot.observation.state === 'error' || !snapshot.codex.skills.includes('bmad-help')) {
      throw new Error('BMAD 或 $bmad-help 尚未準備完成，請重新偵測。');
    }
    return withRunner([`$${bmadRequestSkill(snapshot, request)}`, `工作根目錄：${snapshot.root}`, `BMAD 預設產出位置：${path.join(snapshot.root, '_bmad-output')}`,
      '請依以下需求與目前專案狀態，自行判斷適合的 BMAD 能力與流程，並在此工作根目錄處理：', request.requirement.trim()].join('\n\n'));
  }
  if (request.command === 'codex') {
    if (request.skill || request.stepId || request.artifactId || request.storyId || request.requirement) throw new Error('此指令不接受工作參數。');
    return 'codex';
  }
  if (request.requirement !== undefined) throw new Error('此指令不接受需求文字。');
  if (request.command !== 'skill') throw new Error('不支援此 BMAD 指令。');
  if (request.skill === 'bmad-build-auto' && bmadAutoBuildIssue(snapshot)) throw new Error(bmadAutoBuildIssue(snapshot));
  const node = request.stepId ? snapshot.nodes.find(item => item.id === request.stepId)
    : snapshot.nodes.find(item => item.skill === request.skill);
  if (!node && !request.stepId && request.skill && Object.hasOwn(BMAD_CAPABILITY_GUIDES, request.skill) && !request.artifactId && !request.storyId) {
    return withRunner(`$${request.skill}`);
  }
  if (!node || request.skill && request.skill !== node.skill || !/^bmad-[a-z0-9-]+$/.test(node.skill) ||
    node.action && !/^[a-zA-Z0-9_-]+$/.test(node.action)) throw new Error('找不到此 BMAD 能力，請重新選擇。');
  if (node.skill === 'bmad-build-auto' && bmadAutoBuildIssue(snapshot)) throw new Error(bmadAutoBuildIssue(snapshot));
  if (request.artifactId && request.storyId) throw new Error('請一次選擇一份工作紀錄。');
  let command = `$${node.skill}${node.action ? ` ${node.action}` : ''}`;
  const relative = (filename: string): string => {
    if (!snapshot.root || !path.isAbsolute(filename)) throw new Error('工作路徑無效。');
    const value = path.relative(snapshot.root, filename);
    if (path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) {
      if (snapshot.persistedArtifactRoots?.some(root => within(root, filename))) return filename;
      throw new Error('工作路徑超出目前專案。');
    }
    return value.split(path.sep).join('/');
  };
  if (request.artifactId || request.storyId) {
    if (snapshot.observation.state === 'error' || snapshot.compatibility === 'unsupported') throw new Error('請先重新偵測目前的工作紀錄。');
    if (request.artifactId) {
      const artifact = snapshot.steps.find(step => step.id === node.id)?.artifacts.find(item => item.id === request.artifactId);
      if (!artifact) throw new Error('工作紀錄已不存在或不屬於此能力。');
      if (node.skill === 'bmad-build-auto' && artifact.nativeStatus === 'blocked') throw new Error('Build Auto 已受阻；請先透過智慧入口核對原因，不直接重派。');
      command += ` ${JSON.stringify(relative(artifact.path))}`;
      if (node.skill === 'bmad-build-auto' && artifact.nativeStatus === 'done') command += ' 此紀錄已 done；依原生流程執行 follow-up review，不當作一般 resume。';
    } else {
      const story = snapshot.stories.find(item => item.id === request.storyId);
      if (!story || !['bmad-build', 'bmad-build-auto', 'bmad-code-review', 'bmad-help'].includes(node.skill)) throw new Error('Story 已不存在或不適用此能力。');
      if (node.skill !== 'bmad-help' && (story.status === 'conflict' || story.association === 'unconfirmed' || story.association === 'ambiguous')) {
        throw new Error('Story 對應尚未確認；請先使用 $bmad-help 核對。');
      }
      if (['bmad-build', 'bmad-build-auto'].includes(node.skill) && story.mode === 'spec' && story.inventoryPath) {
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
  return withRunner(command);
}

function within(root: string, target: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) return false;
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
