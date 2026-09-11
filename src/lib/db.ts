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
}

let dbPromise: Promise<IDBPDatabase<RevealPlayerDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<RevealPlayerDB>('RevealPlayerDB', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs')
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
