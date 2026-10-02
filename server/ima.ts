import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Notebook, NoteSnapshot } from '../shared/types.ts';

export interface ImaCredentials { clientId: string; apiKey: string }
export interface ImaClientOptions {
  credentials?: ImaCredentials;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
}
type ReadEndpoint = 'list_notebook' | 'list_note' | 'get_doc_content';
type JsonObject = Record<string, unknown>;
interface NoteInfo { id: string; title: string; folderId: string; folderName: string; modifiedAt: string }

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ima ${description}格式异常；已停止同步。`);
  return value;
}
function arrayField(data: JsonObject, key: string): JsonObject[] {
  const value = data[key];
  if (!Array.isArray(value) || !value.every(object)) throw new Error('ima 列表响应格式异常；已停止同步。');
  return value;
}
function nextCursor(data: JsonObject, current: string, seen: Set<string>): string | null {
  if (data.is_end === true) return null;
  if (data.is_end !== false) throw new Error('ima 分页缺少明确的 is_end，无法确认数据完整。');
  const next = data.next_cursor;
  if (typeof next !== 'string' || !next.trim() || next === current || seen.has(next)) {
    throw new Error('ima 分页尚未结束，但缺少有效的 next_cursor；原资料未更新。');
  }
  return next;
}
function modifiedTime(value: unknown): string {
  const milliseconds = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new Error('ima 笔记修改时间格式异常；已停止同步。');
  }
  return new Date(milliseconds).toISOString();
}

export class ImaClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private credentials: ImaCredentials | undefined;
  private credentialLoad: Promise<ImaCredentials> | undefined;
  private requestTail: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly notebookNames = new Map<string, string>();

  constructor(options: ImaClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.credentials = options.credentials;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.minIntervalMs = options.minIntervalMs ?? 400;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0
      || !Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0) {
      throw new Error('ima 请求超时和间隔设置无效。');
    }
  }

  private async getCredentials(): Promise<ImaCredentials> {
    if (!this.credentialLoad) this.credentialLoad = (async () => {
      let credentials = this.credentials;
      if (!credentials) {
        const clientId = process.env.IMA_OPENAPI_CLIENTID?.trim();
        const apiKey = process.env.IMA_OPENAPI_APIKEY?.trim();
        if (clientId || apiKey) {
          if (!(clientId && apiKey)) throw new Error('请同时配置 IMA_OPENAPI_CLIENTID 和 IMA_OPENAPI_APIKEY。');
          credentials = { clientId, apiKey };
        } else {
          const credentialDirectory = process.env.IMA_REVIEW_CREDENTIAL_DIR?.trim() || join(homedir(), '.config/ima');
          try {
            credentials = {
              clientId: (await readFile(join(credentialDirectory, 'client_id'), 'utf8')).trim(),
              apiKey: (await readFile(join(credentialDirectory, 'api_key'), 'utf8')).trim(),
            };
          } catch { throw new Error('尚未配置 ima 凭证。请配置环境变量或凭证目录中的 client_id/api_key 文件。'); }
        }
      }
      if (!credentials.clientId?.trim() || !credentials.apiKey?.trim()
        || /[\r\n]/.test(credentials.clientId + credentials.apiKey)) throw new Error('ima 凭证配置无效，请检查配置。');
      return { clientId: credentials.clientId.trim(), apiKey: credentials.apiKey.trim() };
    })();
    try { return await this.credentialLoad; }
    catch (error) { this.credentialLoad = undefined; throw error; }
  }

  private request(endpoint: ReadEndpoint, body: JsonObject): Promise<JsonObject> {
    const request = this.requestTail.then(() => this.performRequest(endpoint, body));
    this.requestTail = request.then(() => undefined, () => undefined);
    return request;
  }

  private async performRequest(endpoint: ReadEndpoint, body: JsonObject): Promise<JsonObject> {
    const credentials = await this.getCredentials();
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
    const url = new URL(`/openapi/note/v1/${endpoint}`, 'https://ima.qq.com');
    if (url.origin !== 'https://ima.qq.com') throw new Error('ima 请求目标不在官方域名。');
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('ima 请求超时，请稍后重试。'));
      }, this.timeoutMs);
    });
    this.lastRequestAt = Date.now();
    try {
      return await Promise.race([timeout, (async () => {
        let response: Response;
        try {
          response = await this.fetcher(url, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'ima-openapi-clientid': credentials.clientId,
              'ima-openapi-apikey': credentials.apiKey },
            body: JSON.stringify(body),
          });
        } catch {
          throw new Error(timedOut ? 'ima 请求超时，请稍后重试。' : '无法连接 ima 官方接口，请检查网络后重试。');
        }
        if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)
          || (response.status >= 300 && response.status < 400)) throw new Error('ima 接口发生重定向，已拒绝发送后续请求。');
        if (!response.ok) throw new Error(`ima 接口返回 HTTP ${response.status}，请稍后重试。`);
        let payload: unknown;
        try { payload = await response.json(); }
        catch { throw new Error('ima 接口返回了无效 JSON，请稍后重试。'); }
        if (!object(payload) || typeof payload.code !== 'number') throw new Error('ima 接口缺少有效业务状态码。');
        if (payload.code !== 0) {
          let message = typeof payload.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : '接口调用失败';
          message = message.replaceAll(credentials.clientId, '[已隐藏]').replaceAll(credentials.apiKey, '[已隐藏]').slice(0, 300);
          throw new Error(`ima（${payload.code}）：${message}`);
        }
        if (!object(payload.data)) throw new Error('ima 接口响应缺少有效的数据对象。');
        return payload.data;
      })()]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async getNotebooks(): Promise<Notebook[]> {
    const notebooks = new Map<string, Notebook>();
    let cursor = '0';
    const seen = new Set<string>();
    for (let page = 0; page < 1_000; page++) {
      seen.add(cursor);
      const data = await this.request('list_notebook', { cursor, limit: 20 });
      for (const entry of arrayField(data, 'note_folder_infos')) {
        const id = requiredString(entry.folder_id, '笔记本 ID');
        const name = requiredString(entry.name, '笔记本名称');
        const count = typeof entry.note_number === 'string' && /^\d+$/.test(entry.note_number)
          ? Number(entry.note_number) : entry.note_number;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('ima 笔记本数量格式异常。');
        notebooks.set(id, { id, name, count });
      }
      const next = nextCursor(data, cursor, seen);
      if (next === null) {
        for (const notebook of notebooks.values()) this.notebookNames.set(notebook.id, notebook.name);
        return [...notebooks.values()];
      }
      cursor = next;
    }
    throw new Error('ima 笔记本分页超出安全上限，无法确认数据完整。');
  }

  async getSnapshots(folderIds: string[]): Promise<NoteSnapshot[]> {
    if (!Array.isArray(folderIds) || !folderIds.length || folderIds.some(id => typeof id !== 'string' || !id.trim() || id === '0')) {
      throw new Error('请先选择有效的 ima 笔记本，不能以空范围读取全部笔记。');
    }
    const notes = new Map<string, NoteInfo>();
    for (const folderId of [...new Set(folderIds)]) {
      let cursor = '';
      const seen = new Set<string>();
      let complete = false;
      for (let page = 0; page < 1_000; page++) {
        seen.add(cursor);
        const data = await this.request('list_note', { folder_id: folderId, sort_type: 0, cursor, limit: 20 });
        for (const entry of arrayField(data, 'note_book_list')) {
          const ext = object(entry.note_ext_info) ? entry.note_ext_info : {};
          const actualFolderId = typeof ext.folder_id === 'string' && ext.folder_id ? ext.folder_id : folderId;
          if (actualFolderId !== folderId && !folderId.startsWith('user_list_')) throw new Error('ima 返回了所选笔记本以外的笔记；已停止同步。');
          const note: NoteInfo = {
            id: requiredString(entry.note_id, '笔记 ID'), title: requiredString(entry.title, '笔记标题'),
            folderId: actualFolderId,
            folderName: typeof ext.folder_name === 'string' ? ext.folder_name : this.notebookNames.get(actualFolderId) ?? '',
            modifiedAt: modifiedTime(entry.modify_time),
          };
          const existing = notes.get(note.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(note)) throw new Error('ima 笔记在分页期间发生变化，请重新同步。');
          notes.set(note.id, note);
        }
        const next = nextCursor(data, cursor, seen);
        if (next === null) { complete = true; break; }
        cursor = next;
      }
      if (!complete) throw new Error('ima 笔记分页超出安全上限，无法确认数据完整。');
    }
    const snapshots: NoteSnapshot[] = [];
    for (const note of notes.values()) {
      const data = await this.request('get_doc_content', { note_id: note.id, target_content_format: 2 });
      if (typeof data.content !== 'string') throw new Error('ima 笔记内容格式异常；已停止同步。');
      snapshots.push({ noteId: note.id, title: note.title, folderId: note.folderId, folderName: note.folderName,
        modifiedAt: note.modifiedAt, content: data.content,
        hash: createHash('sha256').update(data.content).digest('hex'), fetchedAt: new Date().toISOString() });
    }
    return snapshots;
  }
}
