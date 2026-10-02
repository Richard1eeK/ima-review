# Mac mini 部署、备份与迁移

本文供目标 Mac 上的登录用户执行。目标是 `127.0.0.1:5190` 后端 + Tailscale Serve 私有 HTTPS + 登录后运行的 LaunchAgent。本文提供步骤，不表示已经在目标 Mac 安装、改过睡眠设置或通过真实手机外网验收。

## 1. 在目标 Mac 准备应用

把项目复制到长期保留的目录，例如 `~/Applications/ima-review`。不要把运行目录放在会自动清理的 Downloads、临时目录或云盘占位文件中。路径有空格或 `&` 没关系，脚本使用绝对路径、参数数组和 plist XML 转义。

在目标 Mac 的已登录用户会话打开终端：

```sh
cd "$HOME/Applications/ima-review"
node --version
npm ci
npm run build
```

需要 Node.js ≥24；实际开发机是 26，新机器以自己的命令输出为准。不要使用 `sudo npm`。先构建再安装后台，服务会由当前 Node 的绝对路径启动。

把自己的 ima 凭证安全迁移到 `~/.config/ima/client_id` 与 `~/.config/ima/api_key`。二者是纯文本文件，不是 JSON。不要把内容填进代码、README、Kimi 提示词或前端环境变量。

```sh
chmod 700 "$HOME/.config/ima"
chmod 600 "$HOME/.config/ima/client_id" "$HOME/.config/ima/api_key"
```

显式设置后端环境。以下配置会被安装脚本写入 plist；`.env` 和 `.zshrc` 不会自动加载。

```sh
export IMA_REVIEW_DATA_DIR="$HOME/Library/Application Support/ima-review"
export IMA_REVIEW_CREDENTIAL_DIR="$HOME/.config/ima"
export IMA_REVIEW_PORT=5190
export IMA_REVIEW_AUTO_SYNC=1
```

先运行 `npm start`，打开 `http://127.0.0.1:5190` 核对题库与同步状态。初次同步、每日同步和网页/命令行手动同步复用同一服务器逻辑；并发同步有状态保护。默认时区 `Asia/Shanghai`、每日同步 `07:00`、学习待办 `20:30`，可在设置中修改。待办在网页内显示，不发送系统通知。

检查成功后按 `Ctrl+C` 停止前台服务。不要同时运行两个服务写同一个数据目录。

## 2. 安装 Tailscale 与私有 HTTPS

在 Mac 和手机上安装 Tailscale，使用**自己的同一 Tailscale 登录身份**加入同一个 tailnet。Mac 推荐使用官方 Standalone 应用；首次启动按系统提示允许 Network Extension 和 VPN 配置。安装方式和授权步骤以[官方 macOS 安装文档](https://tailscale.com/docs/install/mac)及[系统扩展文档](https://tailscale.com/docs/concepts/macos-sysext)为准（2026-10-02 核验）。

以下示例使用 Standalone 应用的 CLI 绝对路径，不需要修改 `.zshrc`：

```sh
TAILSCALE_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
"$TAILSCALE_CLI" version
"$TAILSCALE_CLI" status
```

若这个路径不存在，先核对实际安装的 macOS 变体，使用该变体提供的 CLI；不要为了套用命令同时安装多个变体。[macOS 变体说明](https://tailscale.com/docs/concepts/macos-variants)、[官方 CLI 示例](https://tailscale.com/docs/features/subnet-routers?tab=macos)。

本应用只使用 Serve 代理端口。它在 tailnet 内提供 HTTPS；Funnel 是公开互联网入口，此部署不启用 Funnel。Serve 首次运行如提示 HTTPS 未启用，打开它返回的同意页面完成 tailnet HTTPS 配置。[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)。

先创建代理配置以取得实际 HTTPS 域名；第 4 节完成应用后台启动后再验证页面：

```sh
"$TAILSCALE_CLI" serve --bg --https=443 http://127.0.0.1:5190
"$TAILSCALE_CLI" serve status
```

保留输出的实际 URL，例如 `https://mac-mini.your-tailnet.ts.net`。这里的域名只是示例，不能原样当成自己的地址。`--bg` 保存后台 Serve 配置，重启 Tailscale 后会恢复；这不让登录用户级应用在 macOS 尚未登录时运行。命令格式与关闭方式见[官方 Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

如果这台 Mac 的 443 端口已经代理其他服务，先核对现有 Serve 配置，再选择独立端口和相应 HTTPS origin，避免覆盖已有入口。停用此入口可执行对应原配置的关闭命令：

```sh
"$TAILSCALE_CLI" serve --bg --https=443 http://127.0.0.1:5190 off
```

不要用 `serve reset` 清空这台 Mac 的其他 Serve 配置。

## 3. 限制个人访问与浏览器 origin

在 Tailscale 管理台核对网络访问规则。仅仅“使用 Serve”会限定 tailnet 范围，但默认的宽泛访问规则可能允许 tailnet 内其他人访问。按自己的账号和目标 Mac 的 tailnet IP 限定 HTTPS；以下只是需要合并到现有策略的片段：

```json
{
  "hosts": {
    "ima-review-mac": "100.101.102.103"
  },
  "grants": [
    {
      "src": ["you@example.com"],
      "dst": ["ima-review-mac"],
      "ip": ["tcp:443"]
    }
  ]
}
```

替换邮箱与 IP，保留其他服务必要规则。grants/ACL 是允许规则的组合；新增这条规则不会撤销已有 `* → *` 等宽泛允许，需核对所有匹配目标 Mac 的规则。可以加策略测试验证自己的账号被允许、其他账号被拒绝。[Grants syntax](https://tailscale.com/docs/reference/syntax/grants)、[Grant examples](https://tailscale.com/docs/reference/examples/grants)。

再设置应用自己的身份限制与精确 HTTPS origin：

```sh
export IMA_REVIEW_ALLOWED_USER='you@example.com'
export IMA_REVIEW_ALLOWED_ORIGINS='https://mac-mini.your-tailnet.ts.net'
```

`IMA_REVIEW_ALLOWED_USER` 是 Tailscale 登录身份，不是 macOS 用户名。Serve 将 `Tailscale-User-Login` 传给后端，应用据此核对允许的用户；带标签设备没有这个身份头，使用该配置时应由个人设备访问。[Serve 身份头](https://tailscale.com/docs/features/tailscale-serve#identity-headers)。

`IMA_REVIEW_ALLOWED_ORIGINS` 是显式允许的**额外 origin**，可用逗号分隔多个精确 HTTPS origin，不能带路径、账户、查询或通配符。默认接受请求 Host 对应的同源 origin，所以不配置它也能使用同源的私有 `.ts.net` 页面；本机 localhost 同源开发同样可用。身份校验与 `.ts.net` Host 限制仍适用。API 应通过同一 HTTPS origin 请求；无须把前端单独部署到别的公开域名。

这些身份头只在 loopback 后端与可信 Serve 代理之间使用。服务始终监听 `127.0.0.1`；不要改为 `0.0.0.0`、不要开放路由器端口。能在该 Mac 本机运行程序的用户属于本部署的信任边界。本机 localhost 请求可以直接操作，远程访问须通过 Serve 并匹配允许身份。

## 4. 登录后后台运行

确保前台服务已经停止，以上配置已在当前终端显式 `export`，再预览：

```sh
node scripts/launchagent.mjs print
node scripts/launchagent.mjs install --dry-run
```

预览无需构建完成；只显示检查的布尔状态与不含凭证的 plist，不创建文件、不调用 `launchctl`。实际安装要求 `dist/index.html`、本地依赖、服务源码、凭证文件均存在。

在**目标 Mac 上**执行：

```sh
npm run service:install
npm run service:status
```

脚本创建 `~/Library/LaunchAgents/com.richard.ima-review.plist`，权限 `0600`；数据和日志目录为 `0700`，日志为 `0600`。plist 明确使用绝对 Node、绝对 `node_modules/tsx/dist/cli.mjs`、绝对 `server/index.ts` 与工作目录，设置 `RunAtLoad` 和 `KeepAlive`。重启后在该用户登录时启动，异常退出后由 launchd 重启；每日日程由服务器处理，不另建 cron。

同名服务若来自其他项目目录，脚本会拒绝覆盖或停止。请回到原目录执行其卸载命令后再迁移安装。重新安装同一目录可更新 Node 路径与环境配置。升级 Node、移动项目或改变这些环境变量后，重复预览与安装。

检查本机健康与同步状态：

```sh
curl --fail --silent --show-error \
  -H "Tailscale-User-Login: $IMA_REVIEW_ALLOWED_USER" \
  "http://127.0.0.1:${IMA_REVIEW_PORT:-5190}/api/health"
npm run sync
```

`service:status` 的 loaded 状态只证明 launchd 已加载；还应核对服务进程、健康响应、上次同步成功时间和页面可用性。日志位于数据目录的 `logs/server.stdout.log` 与 `logs/server.stderr.log`。

卸载命令只移除当前项目的后台服务：

```sh
npm run service:uninstall
```

学习数据、备份、日志、凭证和 Tailscale 配置均保留。需要回退版本时，先一致性备份、停止服务，再恢复上一版应用代码、安装依赖与构建，使用同一数据目录重新安装；不要直接回滚数据。

## 5. 登录与睡眠

本方案要求目标 Mac **已经登录且保持唤醒**。锁屏可以继续使用；退出登录、关机、睡眠或重启后停在登录界面时不能保证访问。Tailscale 的 macOS 客户端也依赖用户登录会话；此方案没有安装系统级 daemon，也没有开启自动登录。[Tailscale unattended 说明](https://tailscale.com/docs/how-to/run-unattended)。

在目标 Mac 的系统设置中自行核对“登录项与扩展”里允许后台运行与 Tailscale 登录启动；在桌面 Mac 的能源设置中打开“显示器关闭时，防止自动进入睡眠”等相应选项。菜单名称会随 macOS 版本变化；显示器可以关闭，电脑需继续运行。按[Apple 睡眠与唤醒设置](https://support.apple.com/zh-cn/guide/mac-help/mchle41a6ccd/mac)操作，再用真实重启和外网访问验证。本文没有替用户修改系统设置。

## 6. 一致性备份与迁移

SQLite 在线运行时可能使用 WAL。**不能只复制运行中的 `review.sqlite` 就当作完整备份**。使用网页创建备份或运行：

```sh
npm run backup
```

服务器使用 Node SQLite backup API 生成一致性快照，保存在数据目录的 `backups/`；返回值包含具体文件名。用网页备份链接下载该文件，或访问 `/api/backups/:name`。JSON 完整导出则包含设置、资料、答案、复习、每日计划、来源快照与同步状态，适合通过已校验的恢复接口迁移。Markdown、CSV 和 PDF 用于阅读，不是完整恢复格式。

### 推荐：JSON 迁移

在源 Mac 设置同样的允许身份变量并导出：

```sh
umask 077
curl --fail --silent --show-error \
  -H "Tailscale-User-Login: $IMA_REVIEW_ALLOWED_USER" \
  "http://127.0.0.1:${IMA_REVIEW_PORT:-5190}/api/export?format=json" \
  --output "$HOME/Downloads/ima-review-backup.json"
shasum -a 256 "$HOME/Downloads/ima-review-backup.json"
```

备份含私人学习资料和答案，应安全传输。另行迁移 ima 凭证；学习备份不包含凭证。记录文件哈希与导出时间，在目标 Mac 再算哈希核对一致。切换前停止源 Mac 的后台服务，确保以后只有一台权威服务继续记录学习，避免两边历史分叉。

在目标 Mac 准备好新应用，先以 `IMA_REVIEW_AUTO_SYNC=0` 启动，避免恢复前启动同步；确认要覆盖的是目标实例，先执行 `npm run backup` 保留现有状态。接着运行以下脚本，**它会先校验，再覆盖目标数据**；恢复接口也会自动创建恢复前备份。

```sh
IMA_REVIEW_RESTORE_FILE="$HOME/Downloads/ima-review-backup.json" \
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const backup = JSON.parse(await readFile(process.env.IMA_REVIEW_RESTORE_FILE, 'utf8'));
const base = `http://127.0.0.1:${process.env.IMA_REVIEW_PORT || '5190'}`;
const headers = { 'Content-Type': 'application/json' };
if (process.env.IMA_REVIEW_ALLOWED_USER) headers['Tailscale-User-Login'] = process.env.IMA_REVIEW_ALLOWED_USER;
async function post(path, value) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(`恢复步骤失败：${result.error || response.status}`);
  return result;
}
console.log(await post('/api/restore/validate', backup));
console.log(await post('/api/restore', { backup, confirm: true }));
NODE
```

核对词条、历史原答、修订、反馈、自评、到期时间和今日任务。停止临时服务，重新设置 `IMA_REVIEW_AUTO_SYNC=1`，预览并安装 LaunchAgent，然后手动同步核对资料变化。

### 可选：一致性 SQLite 快照迁移

从备份 API 下载已生成的 `.sqlite` 快照，不复制在线主数据库。停止源服务，在目标 Mac 使用一个**新的空数据目录**；停止目标服务后，复制快照为 `review.sqlite`。以下示例的 `IMA_REVIEW_SQLITE_BACKUP` 必须替换为实际下载文件：

```sh
export IMA_REVIEW_DATA_DIR="$HOME/Library/Application Support/ima-review-migrated"
export IMA_REVIEW_SQLITE_BACKUP="$HOME/Downloads/selected-consistent-backup.sqlite"
node --input-type=module <<'NODE'
import { constants } from 'node:fs';
import { copyFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const source = process.env.IMA_REVIEW_SQLITE_BACKUP;
const folder = process.env.IMA_REVIEW_DATA_DIR;
if (!source || !folder) throw new Error('需要指定备份和新的数据目录。');
const check = new DatabaseSync(source, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get();
check.close();
if (result.integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败。');
await mkdir(folder, { recursive: true, mode: 0o700 });
await chmod(folder, 0o700);
const destination = join(folder, 'review.sqlite');
await copyFile(source, destination, constants.COPYFILE_EXCL); // 已有数据库时拒绝覆盖
await chmod(destination, 0o600);
console.log('一致性快照已复制，请启动目标服务核对学习历史。');
NODE
```

这条路径不合并两台机器的记录。源 Mac 数据与凭证仍保留以便回退；确认目标验收通过前不要删除。复制后使用新的 `IMA_REVIEW_DATA_DIR` 安装后台，并核对全部学习记录。

## 验收

以下每一项都应在目标设备上实际执行并记录结果：

- Mac 本机：构建、健康检查、首次与手动同步，已保存答案刷新后仍在；同步失败后旧资料仍可学习。
- 后台：关闭终端后服务继续运行；退出进程后自动恢复；重启 Mac 并登录后恢复。核对每日同步和网页待办时间。
- 真手机外网：关闭 Wi-Fi，用蜂窝网络并打开 Tailscale，访问 Serve HTTPS，完成新学/复习/应用题、参考、自评和档案；检查软键盘与长文本输入。
- 个人访问：其他 tailnet 用户被拒绝；手机关闭 Tailscale 后访问失败；Serve 配置没有公开 Funnel。
- 持久化：在 Mac 和手机间查看相同历史；未保存输入的失败与重试可恢复，不能显示假的“保存成功”。
- 灾难恢复：生成完整备份、校验、在独立目标实例恢复后比较资料数、答案和到期时间。
- 最终界面：用户自行运行并集成 Kimi 代码后，重新验证功能、减少动效与实际高刷新率设备表现。

本地测试或模拟手机视口通过只覆盖相应开发环境；目标 Mac、真实手机蜂窝网络、Tailscale 身份隔离和最终 Kimi 视觉效果须单独验收。
