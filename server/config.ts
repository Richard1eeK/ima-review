import os from 'node:os';
import path from 'node:path';
export function resolveConfig() {
  const dataDir = path.resolve(process.env.IMA_REVIEW_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ima-review'));
  for (const publicDir of [path.resolve('dist'), path.resolve('public')]) {
    const relative = path.relative(publicDir, dataDir);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('数据目录必须在 dist/public 静态资源目录之外');
  }
  const port = Number(process.env.IMA_REVIEW_PORT || 5190);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('IMA_REVIEW_PORT 必须是 1024–65535 的端口');
  return {
    dataDir, port, host: '127.0.0.1',
    allowedUser: process.env.IMA_REVIEW_ALLOWED_USER || '',
    allowedOrigins: (process.env.IMA_REVIEW_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    autoSync: process.env.IMA_REVIEW_AUTO_SYNC !== '0',
  };
}
