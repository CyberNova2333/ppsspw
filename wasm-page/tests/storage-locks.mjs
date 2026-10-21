import assert from 'node:assert/strict';

// Model Web Locks shared/exclusive compatibility, including nested named locks.
export function storageLocks() {
  const held = new Map();
  const locks = { request: async (name, options, callback) => {
    assert.equal(options.ifAvailable, true);
    const current = held.get(name);
    if (current && (current.mode === 'exclusive' || options.mode === 'exclusive')) return callback(null);
    const state = current || { mode: options.mode, count: 0 };
    state.count++;
    held.set(name, state);
    try { return await callback({ name, mode: options.mode }); }
    finally { if (--state.count === 0) held.delete(name); }
  } };
  return { locks, held };
}
