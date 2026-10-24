const databaseName = 'richiroute.routes.v1';
// One shared connection lets a save on page exit reach IndexedDB before the page unloads.
let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    let blocked = false;
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('summaries', { keyPath: 'id' });
        db.createObjectStore('payloads');
      }
      if (event.oldVersion < 2) db.createObjectStore('draft');
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

export async function transaction<T>(mode: IDBTransactionMode, stores: string[], run: (
  tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void,
) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let error: Error | undefined;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(error ?? tx.error ?? new Error('Speichern wurde abgebrochen.'));
    const fail = (cause: Error) => { error = cause; tx.abort(); };
    try { run(tx, result => { value = result; }, fail); }
    catch (cause) { fail(cause instanceof Error ? cause : new Error('Routenspeicher nicht verfügbar.')); }
  });
}
