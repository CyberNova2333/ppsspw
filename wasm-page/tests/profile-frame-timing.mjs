import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { acquireFrameTimingLease, decodeFrameSnapshot, parseOptions, readFrameSnapshot,
  frameTimingPageState, releaseFrameTimingLease, requestOwnedFrameStop, run, summarizeSubmissions } from '../../scripts/profile-frame-timing.mjs';

const target = 'http://127.0.0.1:17881/';
function raw(state = 2, { capture = 1, ack = 2, reason = 0, context = 1 } = {}) {
  const timestampsUs = [1000, 201000, 401000, 601000, 801000, 1001000];
  return { header: [1, 4, state, capture, ack, reason, state === 0 ? 0 : state === 1 ? 1 : timestampsUs.length, 8192,
    state === 0 ? 0 : 1000, state === 0 ? 0 : state === 1 ? 1000 : 1001000, context, context],
    timestampsUs: state === 2 ? timestampsUs : null };
}

test('CLI bounds duration and requires an exact credential-free target and destination', () => {
  const args = ['--target', target, '--out', '.local/frame.json'];
  assert.equal(parseOptions(args).seconds, 20);
  for (const extra of [['--seconds','0'],['--seconds','121'],['--seconds','NaN'],['--port','1.2'],['--port','65536'],['--out','again'],['--seconds'],['--unknown','1']])
    assert.throws(() => parseOptions([...args,...extra]));
  for (const url of ['file:///tmp/page','http://user:password@localhost/','broken'])
    assert.throws(() => parseOptions(['--target',url,'--out','out.json']));
});

test('submission intervals preserve each complete interval without inventing missing frames', () => {
  const result = summarizeSubmissions([0, 16000, 33000, 100000, 200000]);
  assert.equal(result.completeIntervals, 4);
  assert.equal(result.durationMs, 200);
  assert.equal(result.observedIntervalRateHz, 20);
  assert.equal(result.intervalDistribution.p50Ms, 17);
  assert.equal(result.intervalDistribution.p95Ms, 100);
  assert.equal(result.intervalsAboveMs[50], 2);
  assert.equal(result.intervalsAboveMs[100], 0);
  for (const values of [[],[1],[1,1],[2,1],[-1,2],[0,Infinity],[0,1.5],[0,Number.MAX_SAFE_INTEGER+1]])
    assert.throws(() => summarizeSubmissions(values));
});

test('decoder validates completed boundaries and preserves invalid evidence without distributions', () => {
  const result = decodeFrameSnapshot(raw());
  assert.equal(result.state, 'completed');
  assert.equal(result.intervals.durationMs, 1000);
  const invalid = decodeFrameSnapshot(raw(3, { reason: 2 }));
  assert.equal(invalid.reason, 'capacity');
  assert.equal(invalid.intervals, undefined);
  for (const [slot,value] of [[0,2],[1,3],[2,4],[5,99],[6,8193],[7,9000],[3,0],[4,1],[9,1000],[11,2]]) {
    const valueSet = raw(); valueSet.header[slot] = value;
    assert.throws(() => decodeFrameSnapshot(valueSet), `slot ${slot}`);
  }
  const bad = raw(); bad.timestampsUs[2] = bad.timestampsUs[1];
  assert.throws(() => decodeFrameSnapshot(bad), /increase/);
  const short = raw(); short.timestampsUs.pop();
  assert.throws(() => decodeFrameSnapshot(short), /boundaries/);
});

test('reader rejects odd generations and retries a changed atomic payload', () => {
  const saved = globalThis.Module;
  try {
    globalThis.Module = { _ppssppGetFrameTimingMetric: () => 3 };
    assert.equal(readFrameSnapshot(true), null);
    const fixture = raw(); let changed = false;
    globalThis.Module = { _ppssppGetFrameTimingMetric: slot => {
      if (slot >= 32 && !changed) { fixture.header[1] = 6; changed = true; }
      return slot < 12 ? fixture.header[slot] : fixture.timestampsUs[slot-32];
    } };
    assert.equal(readFrameSnapshot(true).header[1], 6);
    globalThis.Module = {};
    assert.throws(() => readFrameSnapshot(), /absent/);
  } finally { if (saved === undefined) delete globalThis.Module; else globalThis.Module = saved; }
});

test('page ownership prevents competing leases and replacement capture stops', () => {
  const context = vm.createContext({ Date: { now: () => 100 }, Module: { _ppssppGetFrameTimingMetric: slot => raw(1,{capture:9,ack:9}).header[slot] } });
  const call = (fn,...args) => vm.runInContext(`(${fn})(${args.map(x=>JSON.stringify(x)).join(',')})`,context);
  assert.equal(call(acquireFrameTimingLease,'first',1000),true);
  assert.equal(call(acquireFrameTimingLease,'other',1000),false);
  call(releaseFrameTimingLease,'other');
  assert.equal(context.__ppssppFrameTimingOwner.id,'first');
  assert.equal(call(requestOwnedFrameStop,'first',1).error,'capture_replaced');
  call(releaseFrameTimingLease,'first');
  assert.equal(context.__ppssppFrameTimingOwner,undefined);
});

test('WebGL context events invalidate the page observation and release their listeners', () => {
  const listeners = new Map();
  const canvas = { addEventListener: (name,fn)=>listeners.set(name,fn), removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);} };
  const context = vm.createContext({ Date:{now:()=>100}, document:{querySelector:()=>canvas} });
  const call = (fn,...args)=>vm.runInContext(`(${fn})(${args.map(x=>JSON.stringify(x)).join(',')})`,context);
  call(acquireFrameTimingLease,'owner',1000);
  assert.equal(listeners.size,2);
  listeners.get('webglcontextlost')();
  assert.equal(call(frameTimingPageState,'owner').contextLost,true);
  call(releaseFrameTimingLease,'owner');
  assert.equal(listeners.size,0);
});

function browserFixture(options = {}) {
  let clock = 100, current = raw(0,{capture:0,ack:0}), nextId = 1, reads = 0, closed = false;
  const commands = [], samplers = new Set(), samplerCountsAtStart = [];
  const context = vm.createContext({ Date: { now: () => clock }, Module: {
    _ppssppGetFrameTimingMetric: slot => slot < 12 ? current.header[slot] : current.timestampsUs?.[slot-32] ?? -1,
    _ppssppRequestFrameTiming: command => {
      commands.push(command);
      const id = nextId++;
      if (command === 1) { samplerCountsAtStart.push(samplers.size); if (!options.noStartAck) current = raw(1,{capture:id,ack:id}); }
      else if (!options.noStopAck) current = raw(2,{capture:current.header[3],ack:id});
      return id;
    },
  } });
  if (options.existingRecording) current = raw(1,{capture:9,ack:9});
  const argsFrom = expression => JSON.parse('['+expression.match(/\}\)\((.*)\)$/s)[1]+']');
  const client = { async command(method,{expression}) {
    assert.equal(method,'Runtime.evaluate');
    const name = expression.match(/^\(function (\w+)/)?.[1];
    if (name === 'pageSnapshot') {
      const before = reads++ === 0;
      if (!before && options.afterSnapshotError) return {exceptionDetails:{text:'snapshot failed'}};
      return { result:{value:{timestampMs:clock,timeOriginMs:1,visibility:'visible',
        core:{initialized:1,emulating:!before&&options.paused?0:1,sampleAgeMs:!before&&options.stale?3000:0,
          sequence:before||options.sequenceStalled?2:4,vblankCount:before?1:61,actualFlipCount:before?1:31,emulatedTimeUs:before?1000:1001000}}} };
    }
    if (name === 'startPageSampling') { samplers.add(argsFrom(expression)[0]); return {result:{value:{startMs:clock}}}; }
    if (name === 'stopPageSampling') {
      const exists = samplers.delete(argsFrom(expression)[0]);
      return {result:{value:exists?{durationSeconds:1,hiddenMs:options.hidden?1:0,visibilityChanges:options.hidden?2:0,
        raf:{count:60,intervalCount:59,totalMs:1000,droppedSamples:0,intervals:[]},longTasks:{supported:false}}:null}};
    }
    if (name === 'requestOwnedFrameStop' && options.replaceAtStop) current = raw(1,{capture:999,ack:999});
    try { return {result:{value:vm.runInContext(expression,context)}}; }
    catch (error) { return {exceptionDetails:{text:error.message}}; }
  }, close() { closed = true; } };
  return { commands, samplers, samplerCountsAtStart, context, get closed(){return closed;}, dependencies:{fetch:async()=>({json:async()=>[{type:'page',url:target,webSocketDebuggerUrl:'ws://test'}]}),connectCdp:async()=>client,now:()=>clock,delay:async ms=>{
    if (options.measurementError && ms === 1000) throw new Error('measurement failed');
    clock+=ms;
  }} };
}

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(),'profile-frame-'));
  try { await fn(join(directory,'report.json')); }
  finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('profile-frame-'));
    await rm(directory,{recursive:true,force:true});
  }
}

test('collector waits for acknowledgement, exports completed intervals and releases resources', async () => {
  await temporary(async output => {
    const fixture = browserFixture();
    const report = await run({port:9222,seconds:1,target,output},fixture.dependencies);
    assert.equal(report.status,'captured');
    assert.equal(report.submits.count,6);
    assert.deepEqual(fixture.commands,[1,2]);
    assert.deepEqual(fixture.samplerCountsAtStart,[1], 'visibility observation must precede the first native submit');
    assert.equal(fixture.closed,true);
    assert.equal(fixture.samplers.size,0);
    assert.equal(fixture.context.__ppssppFrameTimingOwner,undefined);
    assert.equal(JSON.parse(await readFile(output,'utf8')).status,'captured');
  });
});

test('hidden, stale or paused windows invalidate capture and competing native recordings are not replaced', async () => {
  for (const options of [{hidden:true},{stale:true},{paused:true},{sequenceStalled:true}]) await temporary(async output => {
    const fixture = browserFixture(options);
    const report = await run({port:9222,seconds:1,target,output},fixture.dependencies);
    assert.equal(report.status,'invalid');
    assert.equal(report.submits.intervals,undefined);
  });
  await temporary(async output => {
    const fixture = browserFixture({existingRecording:true});
    await assert.rejects(run({port:9222,seconds:1,target,output},fixture.dependencies),/already_recording/);
    assert.deepEqual(fixture.commands,[]);
    assert.equal(fixture.closed,true);
  });
});

test('a completed native buffer cannot publish interval statistics after the page observation fails', async () => {
  for (const options of [{afterSnapshotError:true},{measurementError:true}]) await temporary(async output => {
    const fixture = browserFixture(options);
    await assert.rejects(run({port:9222,seconds:1,target,output},fixture.dependencies),/failed/);
    const saved = JSON.parse(await readFile(output,'utf8'));
    assert.equal(saved.status,'failed');
    assert.equal(saved.submits.state,'completed');
    assert.equal(saved.submits.timestampsUs.length,6);
    assert.equal(saved.submits.intervals,undefined);
    assert.equal(fixture.closed,true);
    assert.equal(fixture.samplers.size,0);
  });
});

test('replacement and missing swap acknowledgements retain failed evidence without a successful report', async () => {
  for (const options of [{replaceAtStop:true},{noStopAck:true}]) await temporary(async output => {
    const fixture = browserFixture(options);
    await assert.rejects(run({port:9222,seconds:1,target,output},fixture.dependencies));
    const saved = JSON.parse(await readFile(output,'utf8'));
    assert.equal(saved.status,'failed');
    assert.equal(saved.submits?.intervals,undefined);
    assert.equal(fixture.closed,true);
    assert.equal(fixture.samplers.size,0);
    assert.deepEqual(fixture.commands,options.replaceAtStop?[1]:[1,2]);
  });
});

test('unacknowledged start records its uncancelable native request instead of claiming cleanup succeeded', async () => {
  await temporary(async output => {
    const fixture = browserFixture({noStartAck:true});
    await assert.rejects(run({port:9222,seconds:1,target,output},fixture.dependencies),/acknowledged/);
    const saved = JSON.parse(await readFile(output,'utf8'));
    assert.equal(saved.status,'failed');
    assert.match(saved.cleanupFailed,/cannot be canceled/);
    assert.deepEqual(fixture.commands,[1]);
    assert.equal(fixture.closed,true);
    assert.equal(fixture.samplers.size,0);
  });
});

test('collector never overwrites existing evidence', async () => {
  await temporary(async output => {
    await writeFile(output,'keep');
    const fixture = browserFixture();
    await assert.rejects(run({port:9222,seconds:1,target,output},fixture.dependencies),{code:'EEXIST'});
    assert.equal(await readFile(output,'utf8'),'keep');
    assert.deepEqual(fixture.commands,[]);
  });
});
