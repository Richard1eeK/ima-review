import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnswerInput, AnswerUpdate, Settings } from '../shared/types.ts';
import { Store } from './store.ts';
import { resolveConfig } from './config.ts';
import { assert, AppError } from './errors.ts';
import { object, text, validateBackup, validateSettings } from './validation.ts';
import { backupJSON, csvExport, evaluationPack, markdownExport } from './export.ts';
import { SyncService } from './sync.ts';

export interface AppOptions {
  store?: Store; dataDir?: string; sync?: Pick<SyncService, 'run' | 'getNotebooks'>;
  allowedUser?: string; allowedOrigins?: string[]; logger?: boolean;
}
function checkDateFilter(date: unknown) {
  assert(date === undefined || (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))), '日期格式应为 YYYY-MM-DD');
}
export async function createApp(options: AppOptions = {}) {
  const config = resolveConfig();
  const store = options.store || new Store(options.dataDir || config.dataDir);
  const sync = options.sync || new SyncService(store);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const allowedUser = options.allowedUser ?? config.allowedUser;
  const allowedOrigins = options.allowedOrigins ?? config.allowedOrigins;
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';
    const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    const serveHost = /^[a-z\d-]+\.[a-z\d-]+\.ts\.net(?::\d+)?$/i.test(host);
    if (!localHost && !serveHost) throw new AppError('此主机名不在私有访问范围内', 403, 'HOST_DENIED');
    const identity = request.headers['tailscale-user-login'];
    if (!localHost && (!allowedUser || identity !== allowedUser)) throw new AppError('请使用已授权的 Tailscale 身份访问', 403, 'IDENTITY_DENIED');
    const origin = request.headers.origin;
    const expected = new Set([`http://${host}`, `https://${host}`, ...allowedOrigins]);
    if (origin && !expected.has(origin)) throw new AppError('请求来源未获允许', 403, 'ORIGIN_DENIED');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff');
    }
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as AppError;
    const status = e.status || (error as { statusCode?: number }).statusCode || 500;
    if (status >= 500) request.log.error({ errorName: e.name }, 'request failed');
    reply.code(status).send({ error: status >= 500 && !(error instanceof AppError) ? '服务暂时无法完成请求，请稍后重试。' : e.message, code: e.code || 'SERVER_ERROR', ...(e.current ? { current: e.current } : {}) });
  });
  app.get('/api/health', async () => ({ ok: true, app: 'ima-review', version: '0.1.0' }));
  app.get('/api/settings', async () => store.getSettings());
  app.patch('/api/settings', async request => { validateSettings(request.body); return store.saveSettings(request.body as Partial<Settings>); });
  app.get('/api/stats', async () => store.stats());
  app.get<{ Querystring: { q?: string; tag?: string; status?: string; weak?: string } }>('/api/items', async request => {
    const { q = '', tag, status = 'active', weak } = request.query;
    assert(['active', 'archived', 'pending', 'all'].includes(status), '筛选状态无效');
    const needle = q.toLowerCase();
    return store.listItems().filter(x => (status === 'all' || x.status === status) && (!tag || x.tags.includes(tag)) && (weak !== 'true' || x.lastRating === 'again' || x.lastRating === 'hard' || x.needsRelearn)
      && (!needle || [x.term, x.chinese, x.definition, ...x.body].join('\n').toLowerCase().includes(needle)));
  });
  app.get<{ Params: { id: string } }>('/api/items/:id', async request => store.getItem(request.params.id));
  app.patch<{ Params: { id: string } }>('/api/items/:id', async request => {
    object(request.body); assert(Object.keys(request.body).every(k => ['status', 'useLatest'].includes(k)), '词条更新字段无效');
    assert(request.body.useLatest === undefined || typeof request.body.useLatest === 'boolean', 'useLatest 无效');
    return store.updateItem(request.params.id, request.body);
  });
  app.get('/api/plan', async () => store.getDailyPlan());
  app.post('/api/plan/reset', async request => {
    object(request.body); assert(request.body.confirm === true, '请确认重置今日学习');
    text(request.body.date, 'date', 10); checkDateFilter(request.body.date);
    assert(Number.isSafeInteger(request.body.generation) && Number(request.body.generation) >= 0, '计划版本无效');
    return store.resetToday(request.body.date, request.body.generation as number);
  });
  app.get<{ Params: { id: string } }>('/api/resets/:id', async (request, reply) => {
    const value = store.getResetBackup(request.params.id);
    reply.header('Content-Disposition', 'attachment; filename="ima-review-before-reset.json"');
    return reply.type('application/json; charset=utf-8').send(value);
  });
  app.post('/api/learning', async request => {
    object(request.body); text(request.body.itemId, 'itemId', 200);
    const item = store.completeLearning(request.body.itemId, request.body.planGeneration as number | undefined);
    return { item, plan: store.getDailyPlan() };
  });
  app.post('/api/practice', async request => {
    object(request.body); text(request.body.itemId, 'itemId', 200);
    return store.addPractice(request.body.itemId);
  });
  app.get<{ Querystring: { itemId?: string; date?: string } }>('/api/answers', async request => { checkDateFilter(request.query.date); return store.listAnswers(request.query); });
  app.put<{ Params: { id: string } }>('/api/answers/:id', async request => {
    object(request.body); assert(request.body.id === request.params.id, '回答 ID 不匹配');
    return store.saveAnswer(request.body as unknown as AnswerInput);
  });
  app.patch<{ Params: { id: string } }>('/api/answers/:id', async request => {
    object(request.body); assert(Object.keys(request.body).every(k => ['revisedAnswer', 'feedback', 'expectedRevision'].includes(k)), '回答更新字段无效');
    return store.updateAnswer(request.params.id, request.body as unknown as AnswerUpdate);
  });
  app.post('/api/reviews', async request => {
    object(request.body); text(request.body.answerId, 'answerId', 200); text(request.body.rating, 'rating', 20);
    return store.rateAnswer(request.body.answerId, request.body.rating as Parameters<Store['rateAnswer']>[1], request.body.planGeneration as number | undefined);
  });
  app.get('/api/sync', async () => store.getSyncStatus());
  app.post('/api/sync', async () => {
    try { return await sync.run('manual'); }
    catch (error) { throw new AppError(error instanceof Error ? error.message : 'ima 同步失败', 502, 'SYNC_FAILED'); }
  });
  app.get('/api/notebooks', async () => {
    try { return await sync.getNotebooks(); } catch (error) { throw new AppError(error instanceof Error ? error.message : '无法读取笔记本', 502, 'IMA_UNAVAILABLE'); }
  });
  app.get<{ Querystring: { format?: string; date?: string } }>('/api/export', async (request, reply) => {
    const { format = 'markdown', date } = request.query;
    checkDateFilter(date);
    assert(['markdown', 'csv', 'json'].includes(format), '导出格式无效');
    const extension = format === 'markdown' ? 'md' : format;
    reply.header('Content-Disposition', `attachment; filename="ima-review-${date || 'all'}.${extension}"`);
    if (format === 'json') return reply.type('application/json; charset=utf-8').send(backupJSON(store.exportBackup()));
    const answers = store.listAnswers({ date });
    return reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8').send(format === 'csv' ? csvExport(answers) : markdownExport(answers));
  });
  app.get<{ Querystring: { date?: string } }>('/api/evaluation', async request => { checkDateFilter(request.query.date); return { text: evaluationPack(store.listAnswers({ date: request.query.date }).filter(a => a.status !== 'draft')) }; });
  app.get('/api/backups', async () => store.listBackups());
  app.post('/api/backups', async () => store.backup());
  app.get<{ Params: { name: string } }>('/api/backups/:name', async (request, reply) => {
    const found = store.listBackups().find(x => x.name === request.params.name); assert(found, '备份不存在', 404);
    reply.header('Content-Disposition', `attachment; filename="${found.name}"`);
    return reply.type('application/vnd.sqlite3').send(fs.createReadStream(path.join(store.dataDir, 'backups', found.name)));
  });
  app.post('/api/restore/validate', async request => {
    validateBackup(request.body); return { valid: true, counts: { items: request.body.items.length, answers: request.body.answers.length, reviews: request.body.reviews.length } };
  });
  app.post('/api/restore', async request => {
    object(request.body); assert(request.body.confirm === true, '请确认恢复备份');
    await store.restore(request.body.backup); return { restored: true };
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  if (fs.existsSync(path.join(root, 'index.html'))) {
    await app.register(staticPlugin, { root, index: 'index.html', cacheControl: true, maxAge: 0 });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET' || path.extname(request.url.split('?')[0])) return reply.code(404).send({ error: '页面或资源不存在' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => { if (!options.store) store.close(); });
  return { app, store, sync };
}
