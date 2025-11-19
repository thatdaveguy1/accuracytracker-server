
import { DB_NAME, DB_VERSION } from '../constants';
import type { Forecast, Observation, Verification } from '../types';

let db: IDBDatabase | null = null;

export const openDB = (): Promise<IDBDatabase> => {
  if (db) {
    return Promise.resolve(db);
  }
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (e) => {
      const dbInstance = (e.target as IDBOpenDBRequest).result;
      const tx = (e.target as IDBOpenDBRequest).transaction;
      // const oldVersion = e.oldVersion; // Unused now, safer upgrades only.

      if (!tx) {
          console.error('[DB] No transaction available during onupgradeneeded.');
          return;
      }

      // Forecasts store
      let forecastStore: IDBObjectStore;
      if (!dbInstance.objectStoreNames.contains('forecasts')) {
        forecastStore = dbInstance.createObjectStore('forecasts', {keyPath: 'id'});
        forecastStore.createIndex('by_valid_time', 'valid_time');
        forecastStore.createIndex('by_model', 'model_id');
      } else {
        forecastStore = tx.objectStore('forecasts');
      }
      
      // New index for ETA calculation
      if (!forecastStore.indexNames.contains('by_issue_time')) {
        forecastStore.createIndex('by_issue_time', 'issue_time');
      }
      
      // Observations store
      if (!dbInstance.objectStoreNames.contains('observations')) {
        const store = dbInstance.createObjectStore('observations', {keyPath: 'obs_time'});
        store.createIndex('by_time', 'obs_time');
      }
      
      // Verification store
      let verificationStore: IDBObjectStore;
      if (!dbInstance.objectStoreNames.contains('verification')) {
        verificationStore = dbInstance.createObjectStore('verification', {keyPath: 'key'});
      } else {
        verificationStore = tx.objectStore('verification');
      }
      
      if (!verificationStore.indexNames.contains('by_model_var_time')) {
        verificationStore.createIndex('by_model_var_time', ['model_id', 'variable', 'valid_time']);
      }
      if (!verificationStore.indexNames.contains('by_lead_time')) {
        verificationStore.createIndex('by_lead_time', 'lead_time_hours');
      }
      if (!verificationStore.indexNames.contains('by_valid_time')) {
        verificationStore.createIndex('by_valid_time', 'valid_time');
      }
      
      // Metadata store
      if (!dbInstance.objectStoreNames.contains('metadata')) {
        dbInstance.createObjectStore('metadata', {keyPath: 'key'});
      }
      
      console.log('[DB] Schema created/updated');
    };
    
    request.onsuccess = (e) => {
      console.log('[DB] Opened successfully');
      db = (e.target as IDBOpenDBRequest).result;
      
      db.onclose = () => {
        console.warn('[DB] Connection closed unexpectedly. Will reopen on next request.');
        db = null;
      };

      resolve(db);
    };
    
    request.onerror = (e) => {
      console.error('[DB] Open failed:', (e.target as IDBOpenDBRequest).error);
      reject((e.target as IDBOpenDBRequest).error);
    };
  });
};

export const getMetadata = async <T,>(key: string): Promise<T | undefined> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('metadata', 'readonly');
        const store = tx.objectStore('metadata');
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
    });
};

export const setMetadata = async (key: string, value: any): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('metadata', 'readwrite');
        const store = tx.objectStore('metadata');
        const request = store.put({ key, value });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

export const bulkPut = async <T,>(storeName: 'forecasts' | 'observations' | 'verification', data: T[]): Promise<void> => {
    if (data.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        
        data.forEach(item => {
            store.put(item);
        });

        tx.oncomplete = () => {
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
};

export const getCount = async (storeName: 'observations'): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const getAll = async <T,>(storeName: string, indexName?: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = indexName ? store.index(indexName) : store;
        const request = source.getAll(query);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const cleanupOldDataDB = async (cutoff: number): Promise<number> => {
    const db = await openDB();
    let totalDeleted = 0;

    // 1. Observations: Delete using KeyRange (Fast)
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('observations', 'readwrite');
            const store = tx.objectStore('observations');
            const range = IDBKeyRange.upperBound(cutoff);
            const req = store.delete(range); // Range delete is efficient
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
        // Note: delete() doesn't return count in all implementations, so we just assume success.
        totalDeleted += 1; // Placeholder count
    } catch (e) {
        console.error('[DB] Cleanup observations failed', e);
    }

    // 2. Forecasts & Verifications: Delete via Cursor (Batched to prevent UI blocking)
    // These stores don't have time as primary key, so we must use index cursors.
    const stores: ('forecasts' | 'verification')[] = ['forecasts', 'verification'];
    
    for (const storeName of stores) {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const index = store.index('by_valid_time');
            const range = IDBKeyRange.upperBound(cutoff);
            const cursorRequest = index.openCursor(range);
            
            let deletedInTx = 0;
            
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    cursor.delete();
                    deletedInTx++;
                    totalDeleted++;
                    cursor.continue();
                } else {
                    // Done
                    resolve();
                }
            };
            cursorRequest.onerror = (e) => reject((e.target as IDBRequest).error);
        });
    }

    return totalDeleted;
};
