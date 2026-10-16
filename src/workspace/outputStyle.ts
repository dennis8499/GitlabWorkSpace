/** Shared prompt convention; optional presentation policy never changes workflow contracts. */
export const OUTPUT_STYLE_PROMPT = '輸出風格：先在目前所選 Skills root 查找 output-style/SKILL.md；存在時載入 $output-style，優先依當前產出自動選擇精簡、詳解、教學或正式文件風格，並遵循使用者明確指定的 style。未安裝時沿用原 Skill 的 output style。保留原 Skill 的必要欄位、證據、審查狀態、Checklist、REQ／SCN 與核准／驗收要求；舊工作沿用原套件，不為套用風格而安裝或升級。';

export function withOutputStyle(prompt: string): string {
  return !prompt || prompt.includes(OUTPUT_STYLE_PROMPT) ? prompt : `${prompt}\n\n${OUTPUT_STYLE_PROMPT}`;
}
