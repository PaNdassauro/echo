// Imagem de fundo do tema personalizado no IndexedDB (o localStorage não comporta
// imagem). Por navegador, como o resto do tema. Toda falha vira null/false e é logada:
// sem IndexedDB (modo privado, jsdom) o tema segue só com as cores.

const DB_NAME = "echo-theme";
const DB_VERSION = 1;
const STORE = "wallpapers";

export interface WallpaperRecord {
  /** Imagem escolhida, já reduzida (base para refazer os efeitos). */
  original: Blob;
  /** Imagem com os efeitos de `effectsKey` aplicados. */
  processed: Blob;
  effectsKey: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha ao abrir o IndexedDB"));
  });
  // Falha não fica em cache: a próxima chamada tenta de novo.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error ?? new Error("Falha no IndexedDB"));
        tx.onabort = () => reject(tx.error ?? new Error("Transação do IndexedDB abortada"));
      }),
  );
}

function isRecord(value: unknown): value is WallpaperRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.original instanceof Blob && record.processed instanceof Blob && typeof record.effectsKey === "string";
}

export async function getWallpaperRecord(imageId: string): Promise<WallpaperRecord | null> {
  try {
    const value = await run("readonly", (store) => store.get(imageId));
    return isRecord(value) ? value : null;
  } catch (error) {
    console.error("[wallpaper] leitura falhou", error);
    return null;
  }
}

export async function putWallpaperRecord(imageId: string, record: WallpaperRecord): Promise<boolean> {
  try {
    await run("readwrite", (store) => store.put(record, imageId));
    return true;
  } catch (error) {
    console.error("[wallpaper] gravação falhou", error);
    return false;
  }
}

export async function deleteWallpaperRecord(imageId: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(imageId));
  } catch (error) {
    console.error("[wallpaper] remoção falhou", error);
  }
}
