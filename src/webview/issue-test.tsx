/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { IssueView } from './main';
import type { WorkspaceSnapshot } from '../workspace/workspaceProtocol';

window.addEventListener('message', (event) => {
  window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: event.data }));
});

function IssueTestApp() {
  const [manualTime, setManualTime] = useState({ duration: '', summary: '', spentAt: '' });
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [relationResponses, setRelationResponses] = useState<Record<string, Extract<import('../workspace/workspaceProtocol').WorkspaceResponse, { type: 'issueRelations' }>>>({});
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'snapshot') setSnapshot(event.data.snapshot);
      if (event.data?.type === 'issueRelations') setRelationResponses((current) => ({ ...current, [event.data.requestId]: event.data }));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return <IssueView
    snapshot={snapshot}
    relationResponses={relationResponses}
    manualTime={manualTime}
    onManualTimeChange={setManualTime}
    onWorkspaceAction={(request) => window.dispatchEvent(new CustomEvent('workspaceAction', { detail: request }))}
  />;
}

render(<IssueTestApp />, document.getElementById('app')!);
