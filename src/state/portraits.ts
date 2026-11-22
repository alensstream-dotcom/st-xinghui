/**
 * 角色立绘本地缓存(IndexedDB)。
 *
 * 为什么不用 `message.extra` / `extensionSettings`:立绘是几十 KB 到几百 KB 的二进制,
 * 写进聊天记录会让存档暴涨、还会被导出/同步到别处。这里只在角色条目里存一个
 * `portraitKey`(短字符串),图片本体留在浏览器本地,丢了可以重Roll重画。
 */

const DB_NAME = 'xinghui_image_portraits';
const DB_VERSION = 1;
const STORE = 'portraits';

export interface PortraitRecord {
  /** data:image/... base64,直接可当 <img src>。 */
  dataUrl: string;
  /** 生成时间(ms)。 */
  createdAt: number;
  /** 生成时用的种子,便于复现。 */
  seed?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持本地存储,无法保存立绘'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开立绘本地存储失败'));
    request.onblocked = () => reject(new Error('立绘本地存储被其他页面占用,请关掉多余的酒馆标签页'));
  });
  return dbPromise;
}

/** 生成立绘缓存键(只含字母数字与短横线,可安全写进条目)。 */
export function newPortraitKey(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 7);
  return `p-${slug || 'char'}-${stamp}-${salt}`;
}

export async function savePortrait(key: string, record: PortraitRecord): Promise<void> {
  const clean = key?.trim();
  if (!clean) throw new Error('立绘键为空,无法保存');
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record, clean);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('保存立绘失败'));
  });
}

/** 读立绘;不存在返回 null(不抛错——列表里绝大多数角色本来就没立绘)。 */
export async function readPortrait(key?: string): Promise<PortraitRecord | null> {
  const clean = key?.trim();
  if (!clean) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(clean);
    request.onsuccess = () => resolve((request.result as PortraitRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('读取立绘失败'));
  });
}

/** 读成可直接给 <img src> 的数据(不存在返回 null)。 */
export async function readPortraitUrl(key?: string): Promise<string | null> {
  const record = await readPortrait(key);
  return record?.dataUrl || null;
}

export async function deletePortrait(key?: string): Promise<void> {
  const clean = key?.trim();
  if (!clean) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(clean);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('删除立绘失败'));
  });
}