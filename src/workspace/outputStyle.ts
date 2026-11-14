/** Optional presentation is loaded only when explicitly selected for the task. */
const OUTPUT_STYLE_POLICY = '預設沿用本次必要 Skill 的輸出規則。只有使用者明確要求或選取 output-style，才讀取其完整 SKILL.md 與本次必要 reference；其他情況不查找或載入。保留原 Skill 的必要欄位、證據、審查狀態、Checklist、REQ／SCN 與核准／驗收要求；舊工作沿用原套件，不為套用風格而安裝或升級。';
export const OUTPUT_STYLE_PROMPT = `輸出風格：${OUTPUT_STYLE_POLICY}`;

const REPORT_STYLE_PROMPT = `輸出風格（報告階段）：${OUTPUT_STYLE_POLICY}`;
export function withOutputStyle(prompt: string, stage?: 'report'): string {
  return !prompt || prompt.includes(OUTPUT_STYLE_PROMPT) || prompt.includes(REPORT_STYLE_PROMPT) ? prompt
    : `${prompt}\n\n${stage === 'report' ? REPORT_STYLE_PROMPT : OUTPUT_STYLE_PROMPT}`;
}
