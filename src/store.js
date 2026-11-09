// IndexedDB storage. One object store per table; compound keys are array keyPaths.
// Export writes one JSON object: {storeName: [record, ...]}. Import replaces all stores.

export const STORES = {
  books: {keyPath: 'id', indexes: ['digest']},
  chapters: {keyPath: ['book_id', 'number']},
  memories: {keyPath: ['book_id', 'start', 'end', 'level']},
  branches: {keyPath: 'id', indexes: ['book_id']},
  branch_chapters: {keyPath: ['branch_id', 'number']},
  branch_memories: {keyPath: ['branch_id', 'start', 'end', 'level']},
  configured_memory_views: {keyPath: ['identity', 'owner', 'through', 'branch']},
  summary_cache: {keyPath: 'digest'},
};

const NAMES = Object.keys(STORES);
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('novel-if');
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, {keyPath, indexes = []}] of Object.entries(STORES)) {
        const store = db.createObjectStore(name, {keyPath});
        for (const index of indexes) store.createIndex(index, index);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

// Wrap an IDBRequest in a promise.
export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Run fn inside one transaction over the named stores. fn receives {name: IDBObjectStore}
// and may await req() calls. Resolves with fn's result after the transaction commits.
export async function transact(names, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(names, mode);
  const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
  const committed = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  committed.catch(() => {});
  let result;
  try {
    result = await fn(stores);
  } catch (error) {
    tx.abort();
    throw error;
  }
  await committed;
  return result;
}

export async function exportData() {
  const data = await transact(NAMES, 'readonly', async stores => {
    const out = {};
    for (const name of NAMES) out[name] = await req(stores[name].getAll());
    return out;
  });
  return JSON.stringify(data);
}

// Replaces every store. The file must contain every store name.
export async function importData(text) {
  const data = JSON.parse(text);
  await transact(NAMES, 'readwrite', stores => {
    for (const name of NAMES) {
      stores[name].clear();
      for (const record of data[name]) stores[name].put(record);
    }
  });
}
