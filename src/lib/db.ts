import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { FavoriteItem } from '../types'

interface RevealPlayerDB extends DBSchema {
  favorites: {
    key: string
    value: FavoriteItem
  }
  blobs: {
    key: string
    value: Blob
  }
  /**
   * Miscellaneous single values. Holds the config-folder directory handle,
   * which is structured-cloneable and therefore storable here — but NOT in
   * localStorage, which is why this store exists.
   */
  kv: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<RevealPlayerDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<RevealPlayerDB>('RevealPlayerDB', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs')
        }
        // Added in v2 for the config folder handle.
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv')
        }
      },
    })
  }
  return dbPromise
}

// ---- Favorites CRUD ----

export async function saveFavorite(item: FavoriteItem): Promise<void> {
  const db = await getDB()
  await db.put('favorites', item)
}

export async function getFavorites(): Promise<FavoriteItem[]> {
  const db = await getDB()
  const all = await db.getAll('favorites')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteFavorite(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('favorites', id)
}

export async function renameFavorite(id: string, name: string): Promise<void> {
  const db = await getDB()
  const item = await db.get('favorites', id)
  if (item) {
    item.name = name
    await db.put('favorites', item)
  }
}

// ---- Blob storage ----

export async function saveBlob(blob: Blob): Promise<string> {
  const db = await getDB()
  const id = `blob_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  await db.put('blobs', blob, id)
  return id
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await getDB()
  return db.get('blobs', id)
}

export async function deleteBlob(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('blobs', id)
}

// ---- Key/value ----

/**
 * The config folder's FileSystemDirectoryHandle. Persisting it is what lets the
 * next session open the folder without a picker; the value is only meaningful
 * to the File System Access API, hence `unknown` here.
 */
export async function saveConfigDirHandle(handle: unknown): Promise<void> {
  const db = await getDB()
  await db.put('kv', handle, 'configDirHandle')
}

export async function loadConfigDirHandle(): Promise<unknown> {
  const db = await getDB()
  return db.get('kv', 'configDirHandle')
}

export async function clearConfigDirHandle(): Promise<void> {
  const db = await getDB()
  await db.delete('kv', 'configDirHandle')
}
