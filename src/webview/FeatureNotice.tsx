/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { featureNoticeId, groupFeatureBlockers, type FeatureBlocker } from './featureAvailability';
import './feature-notice.css';

export function FeatureNotice({ id, reason, tone = 'hint', details, children, announce = tone !== 'hint' }: {
  id?: string; reason: string; tone?: FeatureBlocker['tone']; details?: string; children?: ComponentChildren; announce?: boolean;
}) {
  return <div id={id} class={`feature-notice feature-notice-${tone}`} role={announce ? tone === 'error' ? 'alert' : 'status' : undefined}>
    <span class="feature-notice-reason">{reason}</span>
    {details && <details class="feature-notice-details"><summary>技術細節</summary><pre>{details}</pre></details>}
    {children && <div class="feature-notice-actions">{children}</div>}
  </div>;
}

/** One cause is rendered once per action group, with all affected controls named. */
export function FeatureNotices({ id, items, children }: {
  id: string; items: Record<string, FeatureBlocker | undefined>; children?: ComponentChildren;
}) {
  const groups = groupFeatureBlockers(items);
  if (!groups.length) return null;
  return <div class="feature-notices">{groups.map(({ blocker, labels }) => <FeatureNotice
    key={featureNoticeId(id, blocker)} id={featureNoticeId(id, blocker)}
    reason={`${labels.join('、')}：${blocker.reason}`} tone={blocker.tone} details={blocker.details} />)}
    {children && <div class="feature-notice-actions">{children}</div>}
  </div>;
}

/** For isolated controls and repeated list rows; grouped toolbars use FeatureNotices. */
export function FeatureButton({ blocker, children, ...props }: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  blocker?: FeatureBlocker; children?: ComponentChildren;
}) {
  const id = useId();
  return <span class="feature-control"><button {...props} disabled={!!blocker} aria-describedby={blocker ? id : undefined}>{children}</button>
    {blocker && <FeatureNotice id={id} {...blocker} />}</span>;
}
