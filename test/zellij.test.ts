import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePane,
  inject,
  resolvePaneId,
  listClaudePanes,
  listSessions,
  listPaneTargets,
  captureTarget,
  injectTarget,
  type ExecFileFn,
} from '../src/zellij.ts';

// Helper to build a fake execFileFn that records calls and returns preset results
function makeFakeExecFile(
  responses: Array<{ stdout: string; stderr?: string } | Error>,
): { fn: ExecFileFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let idx = 0;
  const fn: ExecFileFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const response = responses[idx++];
    if (response instanceof Error) throw response;
    return { stdout: response.stdout, stderr: response.stderr ?? '' };
  };
  return { fn, calls };
}

test('capturePane calls dump-screen with correct args and returns stdout', async () => {
  const { fn, calls } = makeFakeExecFile([{ stdout: 'screen content' }]);
  const result = await capturePane('0', fn);
  assert.equal(result, 'screen content');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'zellij');
  assert.deepEqual(calls[0]!.args, ['action', 'dump-screen', '--pane-id', '0']);
});

test('inject sends Ctrl+C, then write-chars, then Enter', async () => {
  const { fn, calls } = makeFakeExecFile([{ stdout: '' }, { stdout: '' }, { stdout: '' }]);
  await inject('3', 'continue', fn);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ['action', 'write', '--pane-id', '3', '3']); // Ctrl+C
  assert.deepEqual(calls[1]!.args, ['action', 'write-chars', '--pane-id', '3', 'continue']);
  assert.deepEqual(calls[2]!.args, ['action', 'write', '--pane-id', '3', '13']); // Enter
});

const TARGET = { session: 'projA', paneId: '2', label: 'projA:2' };

test('listSessions parses names, skips EXITED and own session', async () => {
  const original = process.env['ZELLIJ_SESSION_NAME'];
  process.env['ZELLIJ_SESSION_NAME'] = 'Claude Retry Monitor';
  try {
    const out =
      'projA [Created 1h ago] \n' +
      'projB [Created 2m ago] \n' +
      'old-one [Created 3h ago] (EXITED - attach to resurrect)\n' +
      'Claude Retry Monitor [Created 5m ago] (current)\n';
    const { fn, calls } = makeFakeExecFile([{ stdout: out }]);
    const result = await listSessions(fn);
    assert.deepEqual(result, ['projA', 'projB']);
    assert.deepEqual(calls[0]!.args, ['list-sessions', '-n']);
  } finally {
    if (original === undefined) delete process.env['ZELLIJ_SESSION_NAME'];
    else process.env['ZELLIJ_SESSION_NAME'] = original;
  }
});

test('listPaneTargets walks sessions, includes all non-plugin live panes', async () => {
  const original = process.env['ZELLIJ_SESSION_NAME'];
  delete process.env['ZELLIJ_SESSION_NAME'];
  try {
    const sessionsOut = 'projA [Created 1h ago] \nprojB [Created 2m ago] \n';
    const panesA = JSON.stringify([
      { id: 0, is_plugin: true, exited: false }, // plugin → excluded
      { id: 1, is_plugin: false, exited: false }, // ✓
      { id: 2, is_plugin: false, exited: false }, // ✓
    ]);
    const panesB = JSON.stringify([
      { id: 0, is_plugin: false, exited: false }, // ✓
      { id: 1, is_plugin: false, exited: true }, // exited → excluded
    ]);
    const { fn, calls } = makeFakeExecFile([
      { stdout: sessionsOut },
      { stdout: panesA },
      { stdout: panesB },
    ]);
    const result = await listPaneTargets(fn);
    assert.deepEqual(result, [
      { session: 'projA', paneId: '1', label: 'projA:1' },
      { session: 'projA', paneId: '2', label: 'projA:2' },
      { session: 'projB', paneId: '0', label: 'projB:0' },
    ]);
    assert.deepEqual(calls[1]!.args, ['--session', 'projA', 'action', 'list-panes', '-j']);
  } finally {
    if (original !== undefined) process.env['ZELLIJ_SESSION_NAME'] = original;
  }
});

test('listPaneTargets skips a session whose list-panes fails', async () => {
  const original = process.env['ZELLIJ_SESSION_NAME'];
  delete process.env['ZELLIJ_SESSION_NAME'];
  try {
    const sessionsOut = 'projA [Created 1h ago] \nprojB [Created 2m ago] \n';
    const panesB = JSON.stringify([{ id: 0, is_plugin: false, exited: false }]);
    const { fn } = makeFakeExecFile([
      { stdout: sessionsOut },
      new Error('session gone'), // projA fails
      { stdout: panesB },
    ]);
    const result = await listPaneTargets(fn);
    assert.deepEqual(result, [{ session: 'projB', paneId: '0', label: 'projB:0' }]);
  } finally {
    if (original !== undefined) process.env['ZELLIJ_SESSION_NAME'] = original;
  }
});

test('captureTarget dumps the target session/pane', async () => {
  const { fn, calls } = makeFakeExecFile([{ stdout: 'screen text' }]);
  const result = await captureTarget(TARGET, fn);
  assert.equal(result, 'screen text');
  assert.deepEqual(calls[0]!.args, ['--session', 'projA', 'action', 'dump-screen', '--pane-id', '2']);
});

test('injectTarget sends Ctrl+C, text, Enter to the target session/pane', async () => {
  const { fn, calls } = makeFakeExecFile([{ stdout: '' }, { stdout: '' }, { stdout: '' }]);
  await injectTarget(TARGET, 'continue', fn);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ['--session', 'projA', 'action', 'write', '--pane-id', '2', '3']);
  assert.deepEqual(calls[1]!.args, ['--session', 'projA', 'action', 'write-chars', '--pane-id', '2', 'continue']);
  assert.deepEqual(calls[2]!.args, ['--session', 'projA', 'action', 'write', '--pane-id', '2', '13']);
});

test('resolvePaneId returns CLAUDE_PANE_ID env var without calling execFile', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  process.env['CLAUDE_PANE_ID'] = '7';
  try {
    const { fn, calls } = makeFakeExecFile([]);
    const result = await resolvePaneId(fn);
    assert.equal(result, '7');
    assert.equal(calls.length, 0);
  } finally {
    if (original === undefined) {
      delete process.env['CLAUDE_PANE_ID'];
    } else {
      process.env['CLAUDE_PANE_ID'] = original;
    }
  }
});

test('resolvePaneId uses list-clients when env var absent', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  delete process.env['CLAUDE_PANE_ID'];
  try {
    const clientsOutput =
      'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n' +
      '1 42 claude --dangerously-skip-permissions\n';
    const { fn, calls } = makeFakeExecFile([{ stdout: clientsOutput }]);
    const result = await resolvePaneId(fn);
    assert.equal(result, '42');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['action', 'list-clients']);
  } finally {
    if (original !== undefined) {
      process.env['CLAUDE_PANE_ID'] = original;
    }
  }
});

test('resolvePaneId falls back to list-panes when list-clients has no claude row', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  delete process.env['CLAUDE_PANE_ID'];
  try {
    const clientsOutput = 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 10 bash\n';
    const panesOutput = JSON.stringify([
      { id: 5, is_plugin: true, title: 'claude plugin' },
      { id: 9, is_plugin: false, title: 'claude' },
      { id: 11, is_plugin: false, title: 'bash' },
    ]);
    const { fn, calls } = makeFakeExecFile([
      { stdout: clientsOutput },
      { stdout: panesOutput },
    ]);
    const result = await resolvePaneId(fn);
    assert.equal(result, '9');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.args, ['action', 'list-panes', '-j']);
  } finally {
    if (original !== undefined) {
      process.env['CLAUDE_PANE_ID'] = original;
    }
  }
});

test('listClaudePanes returns [CLAUDE_PANE_ID] without calling execFile', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  process.env['CLAUDE_PANE_ID'] = '7';
  try {
    const { fn, calls } = makeFakeExecFile([]);
    const result = await listClaudePanes(fn);
    assert.deepEqual(result, ['7']);
    assert.equal(calls.length, 0);
  } finally {
    if (original === undefined) delete process.env['CLAUDE_PANE_ID'];
    else process.env['CLAUDE_PANE_ID'] = original;
  }
});

test('listClaudePanes returns all claude panes, deduped, excluding claude-retry', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  delete process.env['CLAUDE_PANE_ID'];
  try {
    const clientsOutput =
      'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n' +
      '1 42 claude --dangerously-skip-permissions\n' +
      '2 43 claude\n' +
      '3 43 claude\n' + // duplicate pane id (two clients) → deduped
      '4 50 claude-retry start\n' + // monitor's own pane → excluded
      '5 51 bash\n';
    const { fn, calls } = makeFakeExecFile([{ stdout: clientsOutput }]);
    const result = await listClaudePanes(fn);
    assert.deepEqual(result, ['42', '43']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['action', 'list-clients']);
  } finally {
    if (original !== undefined) process.env['CLAUDE_PANE_ID'] = original;
  }
});

test('listClaudePanes returns [] when list-clients fails', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  delete process.env['CLAUDE_PANE_ID'];
  try {
    const { fn } = makeFakeExecFile([new Error('zellij not running')]);
    const result = await listClaudePanes(fn);
    assert.deepEqual(result, []);
  } finally {
    if (original !== undefined) process.env['CLAUDE_PANE_ID'] = original;
  }
});

test('resolvePaneId throws when neither list-clients nor list-panes finds claude', async () => {
  const original = process.env['CLAUDE_PANE_ID'];
  delete process.env['CLAUDE_PANE_ID'];
  try {
    const clientsOutput = 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 10 bash\n';
    const panesOutput = JSON.stringify([
      { id: 5, is_plugin: false, title: 'bash' },
    ]);
    const { fn } = makeFakeExecFile([
      { stdout: clientsOutput },
      { stdout: panesOutput },
    ]);
    await assert.rejects(
      () => resolvePaneId(fn),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Cannot resolve Claude pane ID'));
        return true;
      },
    );
  } finally {
    if (original !== undefined) {
      process.env['CLAUDE_PANE_ID'] = original;
    }
  }
});
