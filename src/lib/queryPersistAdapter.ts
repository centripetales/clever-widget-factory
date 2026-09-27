import Dexie, { Table } from 'dexie';
import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';

type QueryCacheRow = {
  id: string;
  clientState: PersistedClient;
  updatedAt: number;
  // Optional organization scoping for future multi-org support
  organizationId?: string | null;
};

class QueryCacheDatabase extends Dexie {
  cache!: Table<QueryCacheRow>;

  constructor() {
    super('CWFQueryCache');

    this.version(1).stores({
      cache: 'id, updatedAt',
    });
  }
}

const queryCacheDB = new QueryCacheDatabase();

const CACHE_KEY = 'default';

/**
 * IndexedDB-based persister for TanStack Query.
 *
 * This allows queries to be restored from disk so that
 * Assets / Actions pages can load immediately
 * from the last known data, even after being offline.
 */
export const queryCachePersister: Persister = {
  persistClient: async (client: PersistedClient) => {
    try {
      await queryCacheDB.cache.put({
        id: CACHE_KEY,
        clientState: client,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.warn('[QueryPersistAdapter] Failed to persist client state', error);
    }
  },

  restoreClient: async () => {
    try {
      const row = await queryCacheDB.cache.get(CACHE_KEY);
      if (!row) return undefined;
      return row.clientState;
    } catch (error) {
      console.warn('[QueryPersistAdapter] Failed to restore client state', error);
      return undefined;
    }
  },

  removeClient: async () => {
    try {
      await queryCacheDB.cache.delete(CACHE_KEY);
    } catch (error) {
      console.warn('[QueryPersistAdapter] Failed to remove client state', error);
    }
  },
};

// 24 hours in milliseconds – how long we consider persisted cache valid
export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;




