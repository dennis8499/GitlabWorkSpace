/** @jsxImportSource preact */
import type { JSX } from 'preact';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, wikiGuideCards,
  type WikiGuideInputValues
} from './codebaseWikiGuideData';

export function CodebaseWikiGuide({ inputs, onInput, onCopy, onOpenSettings, groupRoot, repositories, workflowKitVersion, kitInstalled }: {
  inputs: WikiGuideInputValues;
  onInput: (key: string, value: string) => void;
  onCopy: (text: string) => void;
  onOpenSettings: () => void;
  groupRoot?: string;
  repositories: Array<{ namespace: string; localPath?: string }>;
  workflowKitVersion?: string;
  kitInstalled: boolean;
}) {
  const context = buildWikiGuideContext({ groupRoot, repositories, workflowKitVersion });
  return <div class="wiki-guide">
    <section class="wiki-guide-intro" aria-labelledby="wiki-guide-intro-title">
      <div>
        <h2 id="wiki-guide-intro-title">Group 分析與共用 Wiki</h2>
        <p>提示詞會帶入目前 Group、Repo 路徑與組合包版本。知識集中於 Group/wiki/；分析仍透過複製提示詞交給 Codex CLI，查證時回到實際 Repo 檔案。</p>
        <p class="wiki-guide-notice">Wiki、Megin 與 MergeReviewer 使用同一組 Group 規則。開始 AI 任務前，工作台會檢查完整工作流程包已安裝。</p>
      </div>
      <button class="secondary" type="button" onClick={onOpenSettings}>管理完整工作流程包</button>
    </section>
    <div class="wiki-guide-grid">
      {wikiGuideCards.map((card) => {
        const prompt = `${context}\n\n${buildWikiGuidePrompt(card.id, inputs)}`;
        const ready = !!groupRoot && kitInstalled && canCopyWikiPrompt(card, inputs);
        return <section class="wiki-guide-card" key={card.id} aria-labelledby={`wiki-card-title-${card.id}`}>
          <header class="wiki-guide-card-header">
            <div><span class="eyebrow">GitLab Workspace · {workflowKitVersion ?? '未安裝'}</span><h2 id={`wiki-card-title-${card.id}`}>{card.title}</h2></div>
          </header>
          <p class="wiki-guide-description">{card.description}</p>
          <p class="wiki-guide-output"><strong>預期產出：</strong>{card.output}</p>
          <p class="wiki-guide-behavior"><strong>執行方式：</strong>{card.behavior}</p>
          {card.id === 'install' ? <div class="wiki-guide-fields"><p>一次管理 14 個 Skills、共用 Wiki 設定與 Group 工作規則。</p><button class="secondary" type="button" onClick={onOpenSettings}>開啟整包安裝與更新</button></div> : <div class="wiki-guide-fields">
            {card.fields.map((item) => {
              const key = `${card.id}.${item.id}`;
              const value = inputs[key] ?? item.defaultValue ?? '';
              const label = <span>{item.label}{item.required && <span class="wiki-required">（必填）</span>}</span>;
              let control: JSX.Element;
              if (item.kind === 'select') {
                control = <select id={`wiki-input-${key}`} value={value} onChange={(event) => onInput(key, event.currentTarget.value)}>
                  {item.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>;
              } else if (item.kind === 'textarea') {
                control = <textarea id={`wiki-input-${key}`} rows={item.rows ?? 2} value={value} placeholder={item.placeholder} required={item.required} onInput={(event) => onInput(key, event.currentTarget.value)} />;
              } else {
                control = <input id={`wiki-input-${key}`} type="text" value={value} placeholder={item.placeholder} required={item.required} onInput={(event) => onInput(key, event.currentTarget.value)} />;
              }
              return <label class="field wiki-guide-field" key={key} for={`wiki-input-${key}`}>{label}{control}</label>;
            })}
          </div>}
          <details class="wiki-prompt-details">
            <summary>檢視提示詞預覽</summary>
            <pre class="wiki-prompt-preview">{prompt}</pre>
          </details>
          {card.id !== 'install' && <button class="primary wiki-copy-button" type="button" disabled={!ready} aria-label={`複製${card.title}提示詞`} onClick={() => onCopy(prompt)}>複製提示詞</button>}
        </section>;
      })}
    </div>
  </div>;
}
