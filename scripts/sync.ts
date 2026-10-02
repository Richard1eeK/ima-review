import { resolveConfig } from '../server/config.ts';
const config = resolveConfig();
const response = await fetch(`http://127.0.0.1:${config.port}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const result = await response.json();
if (!response.ok) { console.error(result.error || '同步失败'); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
