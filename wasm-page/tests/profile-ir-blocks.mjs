import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { acquireIRProfileLease, decodeSnapshot, parseOptions, readIRSnapshot, releaseIRProfileLease,
  requestOwnedIRStop, run } from '../../scripts/profile-ir-blocks.mjs';

const ROW_BASE = 288, ROW_STRIDE = 262, COUNT = 8672;
const target = 'http://127.0.0.1:17881/benchmark.html';

function snapshot({ state = 2, reason = 0, captureId = 1, ack = 2, entries = 7, epoch = 1 } = {}) {
  const values = Array(COUNT).fill(0);
  Object.assign(values, { 0: 1, 1: 4, 2: state, 3: reason, 4: ack, 5: captureId, 6: epoch,
    7: 1000, 8: 2000, 9: entries, 10: entries ? 1 : 0, 11: 1, 13: entries ? 1 : 0,
    14: entries * 2, 15: 128, 16: 32, 18: 1 });
  if (entries) {
    values[32 + 7] = entries * 2;
    values.splice(ROW_BASE, 10, 4, 0x12345678, entries, 2, 2, 0,
      0x03020107, 0xffffffff, 0x07060507, 42);
  }
  return values;
}

test('CLI requires an exact page and destination and bounds diagnostic duration', () => {
  const valid = ['--target', target, '--out', '.local/report.json'];
  assert.deepEqual(parseOptions(valid), { target, output: resolve('.local/report.json'), port: 9222, seconds: 20 });
  assert.equal(parseOptions([...valid, '--seconds', '1.5', '--port', '65535']).seconds, 1.5);
  for (const extra of [['--seconds', '0'], ['--seconds', '121'], ['--seconds', 'NaN'], ['--port', '1.5'],
    ['--port', '65536'], ['--missing', '1'], ['--out', 'again'], ['--seconds']]) {
    assert.throws(() => parseOptions([...valid, ...extra]));
  }
  for (const url of ['file:///tmp/page', 'http://name:password@localhost/', 'not a url'])
    assert.throws(() => parseOptions(['--target', url, '--out', 'report.json']));
  assert.throws(() => parseOptions(['--out', 'report.json']));
});

test('ABI decoder preserves packed register fields, unsigned constants and static totals', () => {
  const values = snapshot(), original = [...values], report = decodeSnapshot(values);
  assert.deepEqual(values, original);
  assert.equal(report.state, 'completed');
  assert.equal(report.weightedStaticOpcodeOccurrences[7], 14);
  assert.equal(report.rows[0].address, 0x12345678);
  assert.deepEqual(report.rows[0].instructions, [
    { opcode: 7, dest: 1, src1: 2, src2: 3, constant: 0xffffffff },
    { opcode: 7, dest: 5, src1: 6, src2: 7, constant: 42 },
  ]);
});

test('invalid captures remain diagnostic evidence and overflow permits saturated sums', () => {
  const values = snapshot({ state: 3, reason: 6 });
  values[20] = 1;
  values[14] = Number.MAX_SAFE_INTEGER;
  values[32] = Number.MAX_SAFE_INTEGER;
  const report = decodeSnapshot(values);
  assert.equal(report.state, 'invalid');
  assert.equal(report.reason, 'counter_overflow');
  assert.equal(report.overflow, true);
  values[20] = 0;
  assert.throws(() => decodeSnapshot(values), /histogram/);
});

test('ABI decoder rejects torn, malformed or contradictory tables', () => {
  for (const [slot, value] of [[0, 2], [1, 3], [3, 99], [9, 0], [10, 2], [13, 33], [15, 127],
    [17, 1], [20, 2], [ROW_BASE, 2 ** 32], [ROW_BASE + 4, 1], [ROW_BASE + 6, 2 ** 32],
    [ROW_BASE + 7, -1], [32 + 7, 15]]) {
    const values = snapshot(); values[slot] = value;
    assert.throws(() => decodeSnapshot(values), `slot ${slot}`);
  }
  assert.throws(() => decodeSnapshot(snapshot().slice(1)));
  const duplicate = snapshot(); duplicate[9] = 14; duplicate[10] = duplicate[11] = duplicate[13] = 2;
  duplicate[14] = duplicate[39] = 28;
  duplicate.splice(ROW_BASE + ROW_STRIDE, ROW_STRIDE, ...duplicate.slice(ROW_BASE, ROW_BASE + ROW_STRIDE));
  assert.throws(() => decodeSnapshot(duplicate), /uniquely ordered/);
});

test('readonly snapshot retries odd and changed generations without requesting core actions', () => {
  const saved = globalThis.Module;
  try {
    let reads = 0;
    globalThis.Module = { _ppssppGetIRBlockProfileMetric: slot => { ++reads; return slot === 1 ? 3 : 0; } };
    assert.equal(readIRSnapshot(), null);
    assert.equal(reads, 4);
    const values = snapshot();
    let changed = false;
    globalThis.Module = { _ppssppGetIRBlockProfileMetric: slot => {
      if (slot === 10 && !changed) { values[1] = 6; changed = true; }
      return values[slot];
    } };
    assert.equal(readIRSnapshot()[1], 6);
    assert.equal(readIRSnapshot(true).length, COUNT);
    delete globalThis.Module;
    assert.throws(() => readIRSnapshot(), /absent/);
  } finally {
    if (saved === undefined) delete globalThis.Module; else globalThis.Module = saved;
  }
});

test('page leases reject another collector and release only their owner', () => {
  const context = vm.createContext({ Date: { now: () => 100 } });
  const call = (fn, ...args) => vm.runInContext(`(${fn})(${args.map(value => JSON.stringify(value)).join(',')})`, context);
  assert.equal(call(acquireIRProfileLease, 'first', 1000), true);
  assert.equal(call(acquireIRProfileLease, 'second', 1000), false);
  call(releaseIRProfileLease, 'second');
  assert.equal(context.__ppssppIRProfileOwner.id, 'first');
  call(releaseIRProfileLease, 'first');
  assert.equal(context.__ppssppIRProfileOwner, undefined);
  context.__ppssppIRProfileOwner = { id: 'expired', expiresAt: 99 };
  assert.equal(call(acquireIRProfileLease, 'new', 1000), true);
});

// Runtime.evaluate is exercised through a VM context using the actual exported
// page functions. Only unrelated page telemetry and rAF setup are simulated.
function browserFixture(options = {}) {
  let clock = 100, current = snapshot({ state: 0, captureId: 0, ack: 0, entries: 0 });
  let nextId = 1, pendingStop = 0, pendingReads = 0, closed = false, telemetryReads = 0;
  let replacementDone = false, fullReads = 0, unstableDone = false;
  const commands = [], samplers = new Set();
  const context = vm.createContext({ Date: { now: () => clock }, Module: {
    _ppssppGetIRBlockProfileMetric: slot => current[slot],
    _ppssppRequestIRBlockProfile: command => {
      commands.push(command);
      const id = nextId++;
      if (command === 1) current = snapshot({ state: 1, captureId: id, ack: id, entries: 0 });
      else { pendingStop = id; pendingReads = 2; }
      return id;
    },
  } });
  if (options.existingLease) context.__ppssppIRProfileOwner = { id: 'other', expiresAt: 999999 };
  const argsFrom = expression => JSON.parse('[' + expression.match(/\}\)\((.*)\)$/s)[1] + ']');
  const client = {
    async command(method, { expression }) {
      assert.equal(method, 'Runtime.evaluate');
      const name = expression.match(/^\(function (\w+)/)?.[1];
      if (name === 'pageSnapshot') {
        const before = telemetryReads++ === 0;
        return { result: { value: { timestampMs: clock, timeOriginMs: 1, visibility: options.initialHidden && before ? 'hidden' : 'visible',
          core: { initialized: 1, emulating: 1, sampleAgeMs: 0, sequence: before ? 2 : 4,
            vblankCount: before ? 1 : 31, actualFlipCount: before ? 1 : 31, emulatedTimeUs: before ? 1000 : 1001000 } } } };
      }
      if (name === 'startPageSampling') {
        if (options.failSampler) return { exceptionDetails: { text: 'simulated sampler failure' } };
        samplers.add(argsFrom(expression)[0]);
        return { result: { value: { startMs: clock } } };
      }
      if (name === 'stopPageSampling') {
        const key = argsFrom(expression)[0], exists = samplers.delete(key);
        return { result: { value: exists ? { durationSeconds: 1, hiddenMs: options.hiddenDuringCapture ? 1 : 0,
          visibilityChanges: options.hiddenDuringCapture ? 2 : 0,
          raf: { count: 60, intervalCount: 59, totalMs: 1000, droppedSamples: 0, intervals: [] }, longTasks: { supported: false } } : null } };
      }
      if (name === 'requestOwnedIRStop' && options.replaceAtStop && !replacementDone) {
        replacementDone = true;
        current = snapshot({ state: 1, captureId: 999, ack: 999 });
      }
      if (name === 'readIRSnapshot') {
        if (options.unstableProgress && samplers.size && !pendingStop && !unstableDone) {
          unstableDone = true;
          return { result: { value: null } };
        }
        if (pendingStop && --pendingReads === 0) {
          current = snapshot({ captureId: current[5], ack: pendingStop });
          pendingStop = 0;
        }
        if (argsFrom(expression)[0]) {
          ++fullReads;
          if (options.replaceFullSnapshot) current = snapshot({ captureId: 999, ack: 999 });
        }
      }
      try { return { result: { value: structuredClone(vm.runInContext(expression, context)) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    },
    close() { closed = true; },
  };
  return {
    context, commands, samplers,
    get closed() { return closed; },
    get fullReads() { return fullReads; },
    dependencies: {
      fetch: async () => ({ ok: true, json: async () => [{ type: 'page', url: target, webSocketDebuggerUrl: 'ws://127.0.0.1/mock' }] }),
      connectCdp: async () => client,
      now: () => clock,
      delay: async milliseconds => {
        clock += milliseconds;
        if (options.invalidate && current[2] === 1 && !pendingStop)
          current = snapshot({ state: 3, reason: 1, captureId: current[5], ack: current[4], epoch: 2 });
      },
    },
  };
}

async function withReport(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'ir-collector-test-'));
  const output = join(directory, 'report.json');
  try { await fn(output); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('collector integrates ACK, visible telemetry, owned stop and lease cleanup', async () => withReport(async output => {
  const browser = browserFixture();
  const report = await run({ port: 9222, seconds: 1, target, output }, browser.dependencies);
  assert.equal(report.status, 'captured');
  assert.equal(report.before.visibility, 'visible');
  assert.equal(report.summary.foregroundThroughout, true);
  assert.equal(report.blocks.captureId, report.captureId);
  assert.deepEqual(browser.commands, [1, 2]);
  assert.equal(browser.context.__ppssppIRProfileOwner, undefined);
  assert.equal(browser.samplers.size, 0);
  assert.equal(browser.closed, true);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
}));

test('hidden windows and invalid core captures cannot become valid reports', async () => {
  for (const fixture of [{ hiddenDuringCapture: true }, { invalidate: true }]) await withReport(async output => {
    const browser = browserFixture(fixture);
    const report = await run({ port: 9222, seconds: 1, target, output }, browser.dependencies);
    assert.equal(report.status, 'invalid');
    if (fixture.invalidate) {
      assert.equal(report.blocks.reason, 'cache_cleared');
      assert.deepEqual(browser.commands, [1]);
    } else assert.equal(report.summary.foregroundThroughout, false);
    assert.equal(browser.context.__ppssppIRProfileOwner, undefined);
  });
});

test('a transient atomic publication during progress polling is retried', async () => withReport(async output => {
  const browser = browserFixture({ unstableProgress: true });
  const report = await run({ port: 9222, seconds: 1, target, output }, browser.dependencies);
  assert.equal(report.status, 'captured');
  assert.deepEqual(browser.commands, [1, 2]);
}));

test('failure cleanup waits for its stop ACK and saves only the owned result', async () => withReport(async output => {
  const browser = browserFixture({ failSampler: true });
  await assert.rejects(run({ port: 9222, seconds: 1, target, output }, browser.dependencies), /evaluation failed/);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.captureId, 1);
  assert.equal(report.blocks.state, 'completed');
  assert.equal(report.blocks.captureId, 1);
  assert.deepEqual(browser.commands, [1, 2]);
  assert.equal(browser.context.__ppssppIRProfileOwner, undefined);
  assert.equal(browser.closed, true);
}));

test('replaced captures are neither stopped nor written to this report', async () => {
  for (const fixture of [{ replaceAtStop: true }, { replaceFullSnapshot: true }]) await withReport(async output => {
    const browser = browserFixture(fixture);
    await assert.rejects(run({ port: 9222, seconds: 1, target, output }, browser.dependencies), /replaced|different capture/);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.blocks, undefined);
    assert.deepEqual(browser.commands, fixture.replaceAtStop ? [1] : [1, 2]);
    assert.equal(browser.context.__ppssppIRProfileOwner, undefined);
    assert.equal(browser.samplers.size, 0);
    assert.equal(browser.closed, true);
  });
});

test('a competing collector cannot start and cannot release the existing lease', async () => withReport(async output => {
  const browser = browserFixture({ existingLease: true });
  await assert.rejects(run({ port: 9222, seconds: 1, target, output }, browser.dependencies), /owns this page/);
  assert.deepEqual(browser.commands, []);
  assert.equal(browser.context.__ppssppIRProfileOwner.id, 'other');
  assert.equal(browser.closed, true);
}));

test('an initially hidden page is rejected before a diagnostic start and releases its lease', async () => withReport(async output => {
  const browser = browserFixture({ initialHidden: true });
  await assert.rejects(run({ port: 9222, seconds: 1, target, output }, browser.dependencies), /visible before capture/);
  assert.deepEqual(browser.commands, []);
  assert.equal(browser.context.__ppssppIRProfileOwner, undefined);
  assert.equal(browser.closed, true);
}));

test('output creation is exclusive before any browser action', async () => withReport(async output => {
  await writeFile(output, 'existing report');
  const browser = browserFixture();
  await assert.rejects(run({ port: 9222, seconds: 1, target, output }, browser.dependencies), /EEXIST/);
  assert.deepEqual(browser.commands, []);
  assert.equal(await readFile(output, 'utf8'), 'existing report');
}));
