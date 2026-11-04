/** MCP 2025-11-25 primitive elicitation forms. Shared by host validation and presentation. */
export function formChoices(field: Record<string, any>): Array<{ value: string; label: string }> {
  if (Array.isArray(field.enum)) return field.enum.map((value: string, index: number) => ({ value, label: field.enumNames?.[index] ?? value }));
  const choices = field.oneOf ?? field.anyOf;
  return Array.isArray(choices) ? choices.filter(choice => typeof choice.const === 'string').map(choice => ({ value: choice.const, label: choice.title ?? choice.const })) : [];
}
export function validateForm(schema: Record<string, any> | undefined, content: Record<string, unknown> | undefined): void {
  if (!schema || schema.type !== 'object' || !content || typeof content !== 'object' || Array.isArray(content)) throw new Error('工具表單格式無效。');
  for (const key of schema.required ?? []) if (content[key] === undefined) throw new Error(`請填寫 ${key}。`);
  for (const [key, value] of Object.entries(content)) {
    const field = schema.properties?.[key];
    if (!field || !['string', 'number', 'integer', 'boolean', 'array'].includes(field.type)) throw new Error('工具表單含有不支援的欄位。');
    if (field.type === 'array') {
      const choices = formChoices(field.items ?? {});
      if (!Array.isArray(value) || !choices.length || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 1000) ||
          new Set(value).size !== value.length || value.some(item => typeof item !== 'string' || !choices.some(choice => choice.value === item))) throw new Error(`${key} 的選項無效。`);
      continue;
    }
    if (field.type === 'integer' ? !Number.isInteger(value) : typeof value !== field.type) throw new Error(`${key} 的型別無效。`);
    const choices = formChoices(field);
    if (choices.length && !choices.some(choice => choice.value === value)) throw new Error(`${key} 的選項無效。`);
    if (typeof value === 'string' && (value.length > (field.maxLength ?? 32_000) || value.length < (field.minLength ?? 0))) throw new Error(`${key} 的長度無效。`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity))) throw new Error(`${key} 的範圍無效。`);
  }
}
