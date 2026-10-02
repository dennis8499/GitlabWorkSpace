/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { IssueView } from './main';
import type { WorkspaceSnapshot } from '../workspace/workspaceProtocol';
import type { DeliveryFormState } from './issue-workflow';

window.addEventListener('message', (event) => {
  window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: event.data }));
});

function IssueTestApp() {
  const [manualTime, setManualTime] = useState({ duration: '', summary: '', spentAt: '' });
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [deliveryForms, setDeliveryForms] = useState<Record<string, DeliveryFormState>>({});
  useEffect(() => {
    const receive = (event: MessageEvent) => { if (event.data?.type === 'snapshot') setSnapshot(event.data.snapshot); };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return <IssueView
    snapshot={snapshot}
    deliveryForms={deliveryForms}
    onDeliveryUpdate={(key, patch) => setDeliveryForms((current) => ({ ...current, [key]: {
      ...(current[key] ?? { workId: '', summary: '', changes: '', tests: '', targetBranch: 'main', reviewerIds: [], acceptanceConfirmed: false }), ...patch
    } }))}
    manualTime={manualTime}
    onManualTimeChange={setManualTime}
    onWorkspaceAction={(request) => window.dispatchEvent(new CustomEvent('workspaceAction', { detail: request }))}
  />;
}

render(<IssueTestApp />, document.getElementById('app')!);
