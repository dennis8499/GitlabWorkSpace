/** @jsxImportSource preact */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { IssueView } from './main';

window.addEventListener('message', (event) => {
  window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: event.data }));
});

function IssueTestApp() {
  const [manualTime, setManualTime] = useState({ duration: '', summary: '', spentAt: '' });
  return <IssueView
    manualTime={manualTime}
    onManualTimeChange={setManualTime}
    onWorkspaceAction={(request) => window.dispatchEvent(new CustomEvent('workspaceAction', { detail: request }))}
  />;
}

render(<IssueTestApp />, document.getElementById('app')!);
