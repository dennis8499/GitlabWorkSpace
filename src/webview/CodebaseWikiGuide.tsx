/** @jsxImportSource preact */
import type { JSX } from 'preact';
import {
  buildWikiGuidePrompt, canCopyWikiPrompt, wikiGuideCards,
  type WikiGuideInputValues
} from './codebaseWikiGuideData';

export function CodebaseWikiGuide({ inputs, onInput, onCopy, onOpenSettings }: {
  inputs: WikiGuideInputValues;
  onInput: (key: string, value: string) => void;
  onCopy: (text: string) => void;
  onOpenSettings: () => void;
}) {
  return <div class="wiki-guide">
    <section class="wiki-guide-intro" aria-labelledby="wiki-guide-intro-title">
      <div>
        <h2 id="wiki-guide-intro-title">使用 Codebase LLM Wiki</h2>
        <p>先在目標 Repo 根目錄開啟 Codex CLI，再選擇工作流程、填寫內容、檢視提示詞並複製執行。提示詞依內附的 Codebase LLM Wiki 0.2.1 Codex 文件整理。</p>
        <p class="wiki-guide-notice">預設工具套件尚未安裝時，請先在設定的「開發工具」選擇並安裝 Codebase LLM Wiki。安裝和更新工作流程會先預覽，再等候你確認。</p>
      </div>
      <button class="secondary" type="button" onClick={onOpenSettings}>開啟開發工具設定</button>
    </section>
    <div class="wiki-guide-grid">
      {wikiGuideCards.map((card) => {
        const prompt = buildWikiGuidePrompt(card.id, inputs);
        const ready = canCopyWikiPrompt(card, inputs);
        return <section class="wiki-guide-card" key={card.id} aria-labelledby={`wiki-card-title-${card.id}`}>
          <header class="wiki-guide-card-header">
            <div><span class="eyebrow">Codebase LLM Wiki · 0.2.1</span><h2 id={`wiki-card-title-${card.id}`}>{card.title}</h2></div>
          </header>
          <p class="wiki-guide-description">{card.description}</p>
          <p class="wiki-guide-output"><strong>預期產出：</strong>{card.output}</p>
          <p class="wiki-guide-behavior"><strong>執行方式：</strong>{card.behavior}</p>
          <div class="wiki-guide-fields">
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
          </div>
          <details class="wiki-prompt-details">
            <summary>檢視提示詞預覽</summary>
            <pre class="wiki-prompt-preview">{prompt}</pre>
          </details>
          <button class="primary wiki-copy-button" type="button" disabled={!ready} aria-label={`複製${card.title}提示詞`} onClick={() => onCopy(prompt)}>複製提示詞</button>
        </section>;
      })}
    </div>
  </div>;
}
