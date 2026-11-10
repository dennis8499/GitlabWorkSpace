import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, type RpcMessage } from '../../src/codex/appServer';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import type { CodexEvent, CodexInteraction, CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';
import { codexInteractionKey, editCodexDraft, editCodexInteractionDraft, restoreCodexUi, retainCodexInteractions,
  settleCodexDrafts } from '../../src/webview/codexUiState';
import type { WorkspaceOperationState } from '../../src/workspace/operations';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** Only the OS child is controlled: production JSONL, task, storage and lease code run unchanged. */
class OfflinePeer {
  readonly client: CodexAppServer;
  readonly calls: RpcMessage[] = [];
  readonly answers: RpcMessage[] = [];
  closeRequested = false;
  closed = false;
  closeGate?: ReturnType<typeof deferred>;
  threadId?: string;
  turnId?: string;
  private readonly child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
  constructor(readonly owner: string, readonly root: string, private readonly world: {
    next: number; owners: Map<string, OfflinePeer>; history: Map<string, { id: string; status: string }>; dispatches: number;
  }) {
    const child = this.child = new EventEmitter() as OfflinePeer['child'];
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).trim().split('\n')) this.receive(JSON.parse(line));
        callback();
      },
      final: callback => {
        this.closeRequested = true;
        void (this.closeGate?.promise ?? Promise.resolve()).then(() => {
          this.closed = true;
          if (world.owners.get(root) === this) world.owners.delete(root);
          callback(); child.emit('close', 0); child.stdout.end(); child.stderr.end();
        });
      }
    });
    child.kill = () => { this.closeGate?.resolve(); return true; };
    this.client = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams, 50, 50);
  }
  send(message: RpcMessage): void { if (!this.closed) this.child.stdout.write(JSON.stringify(message) + '\n'); }
  private receive(message: RpcMessage): void {
    if (!message.method) { this.answers.push(message); return; }
    this.calls.push(message);
    if (message.id === undefined) return;
    const params = message.params ?? {};
    let result: unknown = {};
    switch (message.method) {
      case 'account/read': result = { requiresOpenaiAuth: false }; break;
      case 'windowsSandbox/readiness': result = { status: 'ready' }; break;
      case 'configRequirements/read': result = { requirements: null }; break;
      case 'thread/start': this.threadId = `thread-${++this.world.next}`; result = { thread: { id: this.threadId } }; break;
      case 'thread/resume': this.threadId = params.threadId; result = { thread: { id: this.threadId } }; break;
      case 'thread/turns/list': {
        const turn = this.world.history.get(params.threadId);
        result = { data: turn ? [{ ...turn, items: [] }] : [], nextCursor: null }; break;
      }
      case 'turn/start':
        assert.equal(this.world.owners.has(this.root), false, `overlapping dispatch owner: ${this.root}`);
        this.world.owners.set(this.root, this); this.world.dispatches++;
        this.turnId = `turn-${++this.world.next}`;
        this.world.history.set(this.threadId!, { id: this.turnId, status: 'inProgress' });
        result = { turn: { id: this.turnId, status: 'inProgress', items: [] } }; break;
      case 'turn/steer': return; // The request reaches the peer, but its acknowledgement is lost.
      case 'turn/interrupt':
        this.world.history.set(this.threadId!, { id: this.turnId!, status: 'interrupted' }); break;
    }
    this.send({ id: message.id, result });
  }
  ask(): void {
    this.send({ id: 91, method: 'item/tool/requestUserInput', params: { threadId: this.threadId, turnId: this.turnId,
      questions: [{ id: 'scope', question: 'Which scope?' }] } });
  }
}

test('100 deterministic lifecycle races preserve dispatch ownership, recovery and task-scoped drafts', { timeout: 300_000 }, async t => {
  const temporaryParent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(temporaryParent, 'codex-race-cycles-'));
  const openBridges = new Set<CodexBridge>(), peers: OfflinePeer[] = [];
  const world = { next: 0, owners: new Map<string, OfflinePeer>(), history: new Map<string, { id: string; status: string }>(), dispatches: 0 };
  t.after(async () => {
    for (const peer of peers) peer.closeGate?.resolve();
    await Promise.allSettled([...openBridges].map(bridge => bridge.shutdown()));
    assert.equal(path.dirname(await realpath(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith('codex-race-cycles-'));
    await rm(root, { recursive: true, force: true });
  });
  const start = Date.now(); let completedCycles = 0, rejectedCrossTaskAnswers = 0, rejectedDuplicateAnswers = 0;
  for (let cycle = 0; cycle < 100; cycle++) {
    const directory = path.join(root, String(cycle)), storage = path.join(directory, 'storage');
    const roots = [path.join(directory, 'a'), path.join(directory, 'b')];
    await Promise.all(roots.map(directory => mkdir(directory, { recursive: true })));
    const specs: CodexTaskSpec[] = roots.map(repository => ({ title: 'Race fixture', root: repository,
      workspaceKey: repository, writableRoots: [repository], environmentKey: 'offline-race', prompt: 'hold',
      source: { kind: 'free', repository, prompt: 'hold' } }));
    const ids = [`cycle-${cycle}-a`, `cycle-${cycle}-b`], currentPeers = new Map<string, OfflinePeer>(), schedulerErrors: string[] = [];
    const makeBridge = (owner: string) => {
      const interactions = new Map<string, CodexInteraction[]>();
      const scheduler = new CodexTaskScheduler(owner, directory), acquire = scheduler.tryAcquire.bind(scheduler);
      scheduler.tryAcquire = async (...args) => {
        const result = await acquire(...args);
        if (result.reservation) {
          const release = result.reservation.release;
          result.reservation.release = async (...args) => {
            try { await release(...args); }
            catch (error) { schedulerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
          };
        }
        return result;
      };
      const bridge = new CodexBridge({ storage, version: 'test', trusted: () => true, executable: () => '', maxConcurrent: () => 2,
        scheduler, prepare: async source => specs.find(spec => spec.source.repository === source.repository)!,
        openUrl: async () => {}, event: (event: CodexEvent) => { if (event.kind === 'interactions') interactions.set(event.taskId, event.interactions); },
        client: async repository => {
          const peer = new OfflinePeer(owner, repository, world); peers.push(peer); currentPeers.set(repository, peer);
          await peer.client.initialize('test'); return { client: peer.client, version: '0.166.0', executable: 'offline-controlled-child' };
        } });
      openBridges.add(bridge); return { bridge, interactions };
    };
    const stopBridge = async (bridge: CodexBridge) => { await bridge.shutdown(); openBridges.delete(bridge); };
    const first = makeBridge(`first-${cycle}`), observer = makeBridge(`observer-${cycle}`);
    const admissions = await Promise.all(specs.flatMap((spec, index) => [first.bridge.enqueue(spec, ids[index]), first.bridge.enqueue(spec, ids[index])]));
    assert.deepEqual(admissions, [ids[0], ids[0], ids[1], ids[1]], `duplicate admission cycle ${cycle}`);
    await until(() => first.bridge.list().length === 2 && first.bridge.list().every(task => !!task.turnId), `initial turns ${cycle}`);
    assert.equal(world.dispatches, cycle * 3 + 2);
    const originalThreads = new Map(first.bridge.list().map(task => [task.id, task.threadId]));
    await observer.bridge.publish();
    assert.ok(observer.bridge.list().every(task => task.controls?.external && !task.controls.canPause));
    await assert.rejects(observer.bridge.pause(ids[0]), /另一個/);

    const a = currentPeers.get(roots[0])!, b = currentPeers.get(roots[1])!;
    a.ask(); b.ask();
    await until(() => ids.every(id => first.interactions.get(id)?.length === 1), `questions ${cycle}`);
    const qa = first.interactions.get(ids[0])![0], qb = first.interactions.get(ids[1])![0];
    assert.notEqual(qa.id, qb.id);
    await assert.rejects(first.bridge.answer(ids[1], qa.id, { decision: 'accept', answers: { scope: 'wrong task' } }), /已失效/);
    rejectedCrossTaskAnswers++;
    const answers = await Promise.allSettled([1, 2].map(() => first.bridge.answer(ids[0], qa.id, { decision: 'accept', answers: { scope: `answer-${cycle}` } })));
    assert.equal(answers.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(answers.filter(result => result.status === 'rejected').length, 1); rejectedDuplicateAnswers++;
    assert.equal(a.answers.length, 1); assert.equal(b.answers.length, 0);

    const messageId = `message-${cycle}`;
    const uncertain = await Promise.allSettled([1, 2].map(() => first.bridge.message(ids[0], `preserve-${cycle}`, messageId)));
    assert.ok(uncertain.every(result => result.status === 'rejected'));
    assert.equal(a.calls.filter(call => call.method === 'turn/steer').length, 1);

    let ui = editCodexDraft(editCodexDraft(restoreCodexUi(), ids[0], 'submitted A'), ids[1], 'submitted B');
    for (const [index, id] of ids.entries()) ui.pending[`send-${index}`] = { requestId: `send-${index}`, taskId: id,
      resourceKey: `codex:${id}`, action: 'sendCodexMessage', label: 'Send', text: ui.drafts[id].text, draftRevision: ui.drafts[id].revision };
    ui = editCodexDraft(ui, ids[0], `newer-A-${cycle}`);
    ui = editCodexInteractionDraft(ui, ids[0], qa.id, 'scope', `draft-A-${cycle}`);
    ui = editCodexInteractionDraft(ui, ids[1], qb.id, 'scope', `draft-B-${cycle}`);
    ui = editCodexInteractionDraft(ui, ids[0], qa.id, 'password', 'never-persist', true);
    const serialized = JSON.stringify(ui); assert.ok(!serialized.includes('never-persist'));
    const uiPath = path.join(directory, 'ui-state.json'); await writeFile(uiPath, serialized);

    a.closeGate = deferred();
    const pauses = [first.bridge.pause(ids[0]), first.bridge.pause(ids[0]), first.bridge.pause(ids[1]), first.bridge.pause(ids[1])];
    await until(() => a.closeRequested, `held cleanup ${cycle}`);
    assert.equal(world.owners.get(roots[0]), a, 'ownership remains until child close');
    assert.equal(first.bridge.list().find(task => task.id === ids[0])?.controls?.canResume, false);
    await assert.rejects(observer.bridge.resume(ids[0]), /執行|清理|排隊/);
    a.closeGate.resolve(); await Promise.all(pauses);
    assert.ok(first.bridge.list().every(task => task.status === 'paused'), JSON.stringify({ cycle, schedulerErrors, tasks: first.bridge.list().map(task => ({ id: task.id, status: task.status, error: task.error })) }));
    assert.equal(a.calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(b.calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(world.owners.size, 0);
    await stopBridge(first.bridge); await stopBridge(observer.bridge);

    const restored = makeBridge(`restored-${cycle}`), contender = makeBridge(`contender-${cycle}`);
    await Promise.all([restored.bridge.initialize(), contender.bridge.initialize()]);
    assert.equal(world.dispatches, cycle * 3 + 2, 'restart never auto-dispatches');
    assert.equal(restored.bridge.list().find(task => task.id === ids[0])?.uncertainMessages, 1);
    await assert.rejects(restored.bridge.message(ids[0], `preserve-${cycle}`, messageId), /未確認|不明|逾時/);
    const saved = JSON.parse(await readFile(path.join(storage, 'codex-tasks', ids[0] + '.json'), 'utf8')) as CodexTaskRecord;
    assert.equal(saved.queuedMessages?.[0].state, 'uncertain'); assert.equal(saved.queuedMessages?.[0].text, `preserve-${cycle}`);
    ui = restoreCodexUi(JSON.parse(await readFile(uiPath, 'utf8')));
    const receipts: WorkspaceOperationState[] = ids.map((id, index) => ({ requestId: `send-${index}`, resourceKey: `codex:${id}`,
      scopeRevision: 'fixture', action: 'sendCodexMessage', label: 'Send', status: 'succeeded', effect: 'applied', startedAt: cycle, phase: 'accepted' }));
    ui = settleCodexDrafts(ui, [...receipts].reverse()); ui = settleCodexDrafts(ui, receipts);
    assert.equal(ui.drafts[ids[0]].text, `newer-A-${cycle}`); assert.equal(ui.drafts[ids[1]], undefined);
    assert.equal(ui.interactionDrafts?.[codexInteractionKey(ids[0], qa.id)].values.scope, `draft-A-${cycle}`);
    ui = retainCodexInteractions(ui, ids[0], []);
    assert.equal(ui.interactionDrafts?.[codexInteractionKey(ids[1], qb.id)].values.scope, `draft-B-${cycle}`);

    const resumed = await Promise.allSettled([restored.bridge.resume(ids[0]), contender.bridge.resume(ids[0])]);
    assert.equal(resumed.filter(result => result.status === 'fulfilled').length, 1, `resume winner ${cycle}`);
    assert.equal(resumed.filter(result => result.status === 'rejected').length, 1);
    const winner = resumed[0].status === 'fulfilled' ? restored : contender;
    await until(() => !!winner.bridge.list().find(task => task.id === ids[0])?.turnId, `resumed turn ${cycle}`);
    assert.equal(world.dispatches, cycle * 3 + 3);
    assert.equal(winner.bridge.list().find(task => task.id === ids[0])?.threadId, originalThreads.get(ids[0]));
    const resumedPeer = currentPeers.get(roots[0])!;
    assert.equal(resumedPeer.calls.filter(call => call.method === 'thread/resume').length, 1);
    assert.equal(resumedPeer.calls.filter(call => call.method === 'turn/steer').length, 0, 'uncertain supplements never replay');
    await assert.rejects(winner.bridge.answer(ids[0], qa.id, { decision: 'accept', answers: { scope: 'expired answer' } }), /已失效/);
    await Promise.all([winner.bridge.pause(ids[0]), winner.bridge.pause(ids[0])]);
    await stopBridge(restored.bridge); await stopBridge(contender.bridge);
    const reservations = JSON.parse(await readFile(path.join(directory, 'codex-scheduler-v2', 'reservations.json'), 'utf8'));
    assert.deepEqual(reservations.entries, [], `all scheduler ownership released after cycle ${cycle}`);
    assert.equal(world.owners.size, 0); completedCycles++;
  }
  assert.equal(completedCycles, 100); assert.equal(world.dispatches, 300);
  assert.ok(peers.every(peer => peer.closed));
  t.diagnostic(JSON.stringify({ completedCycles, dispatches: world.dispatches, rejectedCrossTaskAnswers,
    rejectedDuplicateAnswers, ambiguousSupplements: completedCycles, recoveredWithoutReplay: completedCycles, durationMs: Date.now() - start }));
});
