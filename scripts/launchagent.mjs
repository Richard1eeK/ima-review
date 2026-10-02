#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const installerPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(installerPath), '..');
export const label = 'com.richard.ima-review';
const launchctlPath = '/bin/launchctl';
const plutilPath = '/usr/bin/plutil';

export function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function absolutePath(value, base, home) {
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function isWithin(path, parent) {
  const part = relative(parent, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

export function buildConfiguration(env = process.env, root = sourceRoot, home = homedir(), nodePath = process.execPath) {
  root = resolve(root);
  home = resolve(home);
  const port = env.IMA_REVIEW_PORT ?? '5190';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error('IMA_REVIEW_PORT 必须是 1024–65535 的端口号。');
  }
  const autoSync = env.IMA_REVIEW_AUTO_SYNC ?? '1';
  if (autoSync !== '1' && autoSync !== '0') throw new Error('IMA_REVIEW_AUTO_SYNC 只能为 1 或 0。');
  const dataDir = absolutePath(env.IMA_REVIEW_DATA_DIR || join(home, 'Library', 'Application Support', 'ima-review'), root, home);
  if ([join(root, 'dist'), join(root, 'public')].some(path => isWithin(dataDir, path))) {
    throw new Error('数据目录必须位于 dist 和 public 静态资源目录之外。');
  }
  const credentialDir = absolutePath(env.IMA_REVIEW_CREDENTIAL_DIR || join(home, '.config', 'ima'), root, home);
  const origins = (env.IMA_REVIEW_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('IMA_REVIEW_ALLOWED_ORIGINS 必须是逗号分隔的 HTTPS origin。'); }
    if (url.protocol !== 'https:' || url.hostname.includes('*') || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new Error('IMA_REVIEW_ALLOWED_ORIGINS 仅接受 HTTPS origin，不能含路径、查询、账户或通配符。');
    }
    return url.origin;
  });
  const environment = {
    HOME: home,
    PATH: `${dirname(resolve(nodePath))}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_ENV: 'production',
    IMA_REVIEW_DATA_DIR: dataDir,
    IMA_REVIEW_PORT: String(Number(port)),
    IMA_REVIEW_CREDENTIAL_DIR: credentialDir,
    IMA_REVIEW_AUTO_SYNC: autoSync,
    IMA_REVIEW_SOURCE_ROOT: root,
    IMA_REVIEW_INSTALLER_PATH: join(root, 'scripts', 'launchagent.mjs'),
  };
  if (env.IMA_REVIEW_ALLOWED_USER?.trim()) environment.IMA_REVIEW_ALLOWED_USER = env.IMA_REVIEW_ALLOWED_USER.trim();
  if (origins.length) environment.IMA_REVIEW_ALLOWED_ORIGINS = [...new Set(origins)].join(',');
  return {
    root, home, nodePath: resolve(nodePath), dataDir, credentialDir, environment,
    cliPath: join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    serverPath: join(root, 'server', 'index.ts'),
    installerPath: join(root, 'scripts', 'launchagent.mjs'),
    plistPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    logDir: join(dataDir, 'logs'),
    stdoutPath: join(dataDir, 'logs', 'server.stdout.log'),
    stderrPath: join(dataDir, 'logs', 'server.stderr.log'),
  };
}

export function renderPlist(config) {
  const string = value => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>
    ${[config.nodePath, config.cliPath, config.serverPath].map(string).join('\n    ')}
  </array>
  <key>WorkingDirectory</key>${string(config.root)}
  <key>EnvironmentVariables</key>
  <dict>
    ${Object.entries(config.environment).map(([key, value]) => `<key>${xmlEscape(key)}</key>${string(value)}`).join('\n    ')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key>${string(config.stdoutPath)}
  <key>StandardErrorPath</key>${string(config.stderrPath)}
</dict>
</plist>
`;
}

export function isSameInstallation(plist, config) {
  return plist?.Label === label
    && plist.EnvironmentVariables?.IMA_REVIEW_SOURCE_ROOT === config.root
    && plist.EnvironmentVariables?.IMA_REVIEW_INSTALLER_PATH === config.installerPath
    && plist.WorkingDirectory === config.root
    && Array.isArray(plist.ProgramArguments)
    && plist.ProgramArguments.length === 3
    && isAbsolute(plist.ProgramArguments[0])
    && plist.ProgramArguments[1] === config.cliPath
    && plist.ProgramArguments[2] === config.serverPath;
}

async function readable(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

async function credentialsAvailable(config) {
  // Values stay in this process. Neither preview nor status prints credential contents.
  try {
    const values = await Promise.all(['client_id', 'api_key'].map(name => readFile(join(config.credentialDir, name), 'utf8')));
    return values.every(value => value.trim().length > 0 && !/[\r\n]/.test(value.trim()));
  } catch { return false; }
}

async function prerequisites(config) {
  const dependencyFiles = [config.cliPath, ...['fastify', '@fastify/static', 'ts-fsrs'].map(name => join(config.root, 'node_modules', name, 'package.json'))];
  const [build, dependencies, server, credentials] = await Promise.all([
    readable(join(config.root, 'dist', 'index.html')),
    Promise.all(dependencyFiles.map(readable)).then(values => values.every(Boolean)),
    readable(config.serverPath), credentialsAvailable(config),
  ]);
  return { build, dependencies, server, credentials };
}

async function inspectInstalled(config) {
  let stat;
  try { stat = await lstat(config.plistPath); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, own: false, contents: null };
    throw new Error('无法读取 LaunchAgent 文件状态。');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, own: false, contents: null };
  try {
    const contents = await readFile(config.plistPath, 'utf8');
    const { stdout } = await execFile(plutilPath, ['-convert', 'json', '-o', '-', config.plistPath], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { exists: true, own: isSameInstallation(JSON.parse(stdout), config), contents };
  } catch { return { exists: true, own: false, contents: null }; }
}

function serviceTarget() { return `gui/${process.getuid()}/${label}`; }
function guiDomain() { return `gui/${process.getuid()}`; }

async function loadedStatus() {
  try {
    const { stdout } = await execFile(launchctlPath, ['print', serviceTarget()], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { loaded: true, state: stdout.match(/^\s*state = ([^\n]+)$/m)?.[1]?.trim() ?? 'unknown', pid: stdout.match(/^\s*pid = (\d+)$/m)?.[1] ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 macOS launchctl。');
    return { loaded: false, state: 'unloaded', pid: null };
  }
}

async function runLaunchctl(args, description) {
  try { await execFile(launchctlPath, args, { timeout: 15000, maxBuffer: 1024 * 1024 }); }
  catch (error) { throw new Error(`${description}失败（launchctl ${typeof error.code === 'number' ? error.code : '执行错误'}）。请在目标 Mac 已登录的用户会话中执行，并检查服务日志。`); }
}

async function writePrivatePlist(config, contents) {
  const current = await inspectInstalled(config);
  if (current.exists && !current.own) throw new Error('已有同名 LaunchAgent 不属于当前项目目录，拒绝覆盖。请使用原目录的卸载命令处理。');
  const temporary = `${config.plistPath}.${process.pid}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    created = true;
    await rename(temporary, config.plistPath);
    await chmod(config.plistPath, 0o600);
  } finally {
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function install(config) {
  const ready = await prerequisites(config);
  if (!Object.values(ready).every(Boolean)) {
    throw new Error(`安装前检查未通过：${JSON.stringify(ready)}。请先 npm ci、npm run build，并将凭证保存在凭证目录的 client_id 与 api_key 文件；环境变量凭证不会写入 plist。`);
  }
  const [existing, loaded] = await Promise.all([inspectInstalled(config), loadedStatus()]);
  if (existing.exists && !existing.own) throw new Error('已有同名 LaunchAgent 不属于当前项目目录，拒绝覆盖或停止它。');
  if (loaded.loaded && !existing.own) throw new Error('同名服务已加载，但没有可验证的当前安装文件，拒绝替换。');
  await mkdir(dirname(config.plistPath), { recursive: true, mode: 0o700 });
  for (const directory of [config.dataDir, config.logDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const path of [config.stdoutPath, config.stderrPath]) {
    await writeFile(path, '', { flag: 'a', mode: 0o600 });
    await chmod(path, 0o600);
  }
  // Finish the atomic file write before stopping a working service.
  await writePrivatePlist(config, renderPlist(config));
  let stopped = false;
  try {
    if (loaded.loaded) {
      await runLaunchctl(['bootout', serviceTarget()], '停止当前服务');
      stopped = true;
    }
    await runLaunchctl(['enable', serviceTarget()], '启用服务');
    await runLaunchctl(['bootstrap', guiDomain(), config.plistPath], '加载服务');
  } catch (error) {
    // Preserve the previous installation when an update fails to load.
    if (existing.own && existing.contents) {
      await writePrivatePlist(config, existing.contents);
      if (stopped) await runLaunchctl(['bootstrap', guiDomain(), config.plistPath], '恢复原服务');
    } else {
      await unlink(config.plistPath);
    }
    throw error;
  }
  console.log(`已加载 ${label}；它将在当前用户登录后启动并在退出时重启。`);
  console.log(`本机地址：http://127.0.0.1:${config.environment.IMA_REVIEW_PORT}`);
  console.log(`数据目录：${config.dataDir}`);
  console.log('请再检查 /api/health 与 service:status；加载成功不代表同步或远程访问已验证。');
}

async function uninstall(config) {
  const existing = await inspectInstalled(config);
  if (!existing.exists) { console.log('当前目录没有可卸载的 LaunchAgent 文件；未停止其他同名服务。'); return; }
  if (!existing.own) throw new Error('同名 LaunchAgent 不属于当前项目目录，拒绝卸载。');
  if ((await loadedStatus()).loaded) await runLaunchctl(['bootout', serviceTarget()], '卸载服务');
  await unlink(config.plistPath);
  console.log(`已卸载 ${label}。学习数据、备份、日志与 ima 凭证均保留。`);
}

async function status(config) {
  const [installed, loaded, ready] = await Promise.all([inspectInstalled(config), loadedStatus(), prerequisites(config)]);
  console.log(JSON.stringify({ label, plistExists: installed.exists, belongsToThisProject: installed.own, ...loaded, prerequisites: ready }, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'print';
  if (!['install', 'uninstall', 'status', 'print'].includes(command) || argv.slice(1).some(value => value !== '--dry-run')) {
    throw new Error('用法：node scripts/launchagent.mjs install|uninstall|status|print [--dry-run]');
  }
  const config = buildConfiguration();
  if (command === 'print' || argv.includes('--dry-run')) {
    console.error(`仅预览；不写文件、不调用 launchctl。目标 plist：${config.plistPath}`);
    console.error(`安装前检查（只显示布尔值）：${JSON.stringify(await prerequisites(config))}`);
    console.error('环境明确写入 plist；不会读取 .zshrc，也不会嵌入 ima 凭证。预览无需先构建。');
    process.stdout.write(renderPlist(config));
    return;
  }
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('服务管理仅支持 macOS 的普通用户登录会话，请勿使用 sudo。');
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
  // launchd always receives absolute executable and script paths, including paths containing spaces or &.
  config.nodePath = await realpath(config.nodePath);
  if (command === 'install') await install(config);
  else if (command === 'uninstall') await uninstall(config);
  else await status(config);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath === await realpath(installerPath)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
