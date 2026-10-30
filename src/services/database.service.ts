const databaseName = 'richiroute.routes.v1';
// One shared connection lets a save on page exit reach IndexedDB before the page unloads.
let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 4);
    let blocked = false;
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('summaries', { keyPath: 'id' });
        db.createObjectStore('payloads');
      }
      if (event.oldVersion < 2) db.createObjectStore('draft');
      // Version 3, never released, kept the recently edited routes whole in one store; listing them read every route.
      if (event.oldVersion < 4) {
        if (db.objectStoreNames.contains('recent')) db.deleteObjectStore('recent');
        db.createObjectStore('recentSummaries', { keyPath: 'id' });
        db.createObjectStore('recentPayloads');
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Der Routenspeicher ist blockiert. Bitte andere RichiRoute-Tabs schließen und erneut versuchen.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = db.onclose = () => { db.close(); connection = undefined; };
      if (blocked) db.close();
      else resolve(db);
    };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

// What a request callback throws would abort the transaction without its cause, so callbacks go through guard.
export async function transaction<T>(mode: IDBTransactionMode, stores: string[], run: (
  tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void, guard: (callback: () => void) => () => void,
) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let error: Error | undefined;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(error ?? tx.error ?? new Error('Speichern wurde abgebrochen.'));
    const fail = (cause: Error) => { error = cause; tx.abort(); };
    const guard = (callback: () => void) => () => {
      try { callback(); }
      catch (cause) { fail(cause instanceof Error ? cause : new Error('Routenspeicher nicht verfügbar.')); }
    };
    guard(() => run(tx, result => { value = result; }, fail, guard))();
  });
}
