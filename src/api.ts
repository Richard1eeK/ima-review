import type { AnswerRecord, ApiError } from '../shared/types';

export class RequestError extends Error {
  status: number;
  code?: string;
  current?: AnswerRecord;
  constructor(status: number, data: ApiError) {
    super(data.error || '请求未能完成，请重试。');
    this.name = 'RequestError';
    this.status = status;
    this.code = data.code;
    this.current = data.current;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new Error('连接未完成。输入已保留，请检查服务是否运行后重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(response.status, data ?? { error: `请求失败（${response.status}），请重试。` });
  }
  if (data === null) throw new Error('未收到有效结果，请重试。');
  return data as T;
}

export function write<T>(path: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown): Promise<T> {
  return request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function query(values: Record<string, string | boolean | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  });
  return params.size ? `?${params.toString()}` : '';
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
