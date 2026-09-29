export interface ManualTimeDraft {
  duration: string;
  summary: string;
  spentAt: string;
}

export interface ManualTimeStateSource {
  manualTime?: ManualTimeDraft;
  manualTimes?: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
}

export interface RestoredManualTimeState {
  manualTimes: Record<string, ManualTimeDraft>;
  recoveredManualTime?: ManualTimeDraft;
}

function hasContent(value?: ManualTimeDraft): value is ManualTimeDraft {
  return !!value && !!(value.duration.trim() || value.summary.trim() || value.spentAt.trim());
}

/** Preserve legacy, unattributed drafts for explicit recovery; never guess their Issue. */
export function restoreManualTimeState(
  scoped?: ManualTimeStateSource,
  fallback?: ManualTimeStateSource
): RestoredManualTimeState {
  const manualTimes = { ...(fallback?.manualTimes ?? {}), ...(scoped?.manualTimes ?? {}) };
  const recoveredManualTime = scoped?.recoveredManualTime
    ?? fallback?.recoveredManualTime
    ?? (hasContent(scoped?.manualTime) ? scoped.manualTime : undefined)
    ?? (hasContent(fallback?.manualTime) ? fallback.manualTime : undefined);
  return { manualTimes, recoveredManualTime };
}
