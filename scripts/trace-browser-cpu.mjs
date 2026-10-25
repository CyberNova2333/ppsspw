import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const CATEGORY = 'disabled-by-default-v8.cpu_profiler';

export function requireDedicatedBrowser(targets, targetId) {
  if (!targetId || !Array.isArray(targets) || targets.filter(target => target.type === 'page').length !== 1
      || !targets.some(target => target.type === 'page' && target.targetId === targetId)
      || targets.some(target => !['page', 'worker', 'browser'].includes(target.type))) {
    throw new Error('--trace-cpu requires a dedicated browser containing only the selected player page and its workers.');
  }
}

// Tracing is browser-wide. Never silently fall back to it from page profiling.
export async function startBrowserCpuTrace(client, { targetId, output, commandTimeoutMs = 5000,
  completeTimeoutMs = 15000, streamDeadlineMs = 30000, maxBytes = 128 * 1024 * 1024 } = {}) {
  for (const value of [commandTimeoutMs, completeTimeoutMs, streamDeadlineMs, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Trace limits must be positive integers.');
  }
  const command = (method, params = {}) => client.command(method, params, undefined, { timeoutMs: commandTimeoutMs });
  const { targetInfos } = await command('Target.getTargets');
  requireDedicatedBrowser(targetInfos, targetId);
  const tracePath = output + '.trace.json', metadataPath = output + '.trace-meta.json';
  // Reserve both paths before recording. Partial files are retained with failed
  // metadata; existing reports, input aliases and links are never overwritten.
  const metadataFile = await open(metadataPath, 'wx');
  let traceFile, started = false, endSent = false, finishPromise, completion, stream;
  let resolveComplete;
  const complete = new Promise(resolve => { resolveComplete = resolve; });
  const unsubscribe = client.onEvent(message => {
    if (message.method === 'Tracing.tracingComplete' && !completion) {
      completion = message.params; resolveComplete(completion);
    }
  });
  const metadata = { schemaVersion: 1, status: 'recording', category: CATEGORY, intervalUs: null,
    dataLossOccurred: null, traceSha256: null, bytes: 0,
    meaning: 'Browser-wide V8 trace from a dedicated browser. Sampling interval is controlled by the browser implementation; this is not CPU utilization or an unprofiled FPS baseline.' };
  async function release() {
    unsubscribe();
    if (stream) {
      try { await command('IO.close', { handle: stream }); } catch { metadata.cleanupFailed = true; }
      stream = null;
    }
    try { await traceFile?.close(); } catch { metadata.cleanupFailed = true; }
    try { await metadataFile.writeFile(JSON.stringify(metadata, null, 2) + '\n'); }
    finally { await metadataFile.close(); }
  }
  async function waitForCompletion() {
    let timer;
    try {
      return await Promise.race([complete, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser trace completion timeout.')), completeTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function stop() {
    if (!started || endSent) return;
    endSent = true;
    await command('Tracing.end');
  }
  try {
    traceFile = await open(tracePath, 'wx');
    await command('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
      traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 128 * 1024,
        includedCategories: [CATEGORY], excludedCategories: ['*'] } });
    started = true;
  } catch (error) {
    metadata.status = 'failed'; metadata.failure = 'Trace startup failed.';
    await release(); throw error;
  }
  return {
    finish() {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        try {
          await stop();
          const result = await waitForCompletion();
          stream = result.stream;
          metadata.dataLossOccurred = typeof result.dataLossOccurred === 'boolean' ? result.dataLossOccurred : null;
          if (!stream || (result.traceFormat && result.traceFormat !== 'json')
              || (result.streamCompression && result.streamCompression !== 'none')) throw new Error('Browser trace did not return an uncompressed JSON stream.');
          const digest = createHash('sha256'), deadline = Date.now() + streamDeadlineMs;
          let eof = false;
          while (!eof) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw new Error('Browser trace stream deadline exceeded.');
            const chunk = await client.command('IO.read', { handle: stream, size: 1024 * 1024 }, undefined,
              { timeoutMs: Math.min(commandTimeoutMs, remainingMs) });
            if (typeof chunk.data !== 'string' || typeof chunk.eof !== 'boolean'
                || (chunk.base64Encoded !== undefined && typeof chunk.base64Encoded !== 'boolean')) throw new Error('Invalid browser trace stream chunk.');
            const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
            if (metadata.bytes + bytes.length > maxBytes) throw new Error('Browser trace exceeds the output size limit.');
            if (!bytes.length && !chunk.eof) throw new Error('Browser trace stream made no progress.');
            await traceFile.writeFile(bytes); metadata.bytes += bytes.length; digest.update(bytes); eof = chunk.eof;
          }
          if (!metadata.bytes) throw new Error('Browser trace stream is empty.');
          metadata.traceSha256 = digest.digest('hex');
          if (metadata.dataLossOccurred !== false) throw new Error('Browser trace data loss is reported or unknown; capture is invalid.');
          metadata.status = 'captured';
          return metadata;
        } catch (error) {
          metadata.status = 'failed'; metadata.failure = error.message;
          throw error;
        } finally { await release(); }
      })();
      return finishPromise;
    },
    abort() {
      if (finishPromise) return finishPromise.catch(() => {});
      finishPromise = (async () => {
        try {
          await stop();
          const result = await waitForCompletion(); stream = result.stream;
        } catch { /* Failure is recorded; never repeat Tracing.end against another capture. */ }
        finally {
          metadata.status = 'failed'; metadata.failure = 'Page capture did not complete.';
          await release();
        }
      })();
      return finishPromise;
    },
  };
}
