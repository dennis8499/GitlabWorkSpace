/** Interpret a date-only entry in the user's local timezone, or use the submission time. */
export function timeEntryTimestamp(date?: string, now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('無法確認目前時間。');
  if (!date) return now.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('日期請使用有效的 YYYY-MM-DD 格式。');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(0, 0, 0, 0);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    throw new Error('日期請使用有效的 YYYY-MM-DD 格式。');
  }
  if (value.getTime() > now.getTime()) throw new Error('工時日期不能是未來日期。');
  return value.toISOString();
}
