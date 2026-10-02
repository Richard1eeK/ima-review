# ima 英语复习

把 ima 中的英语笔记同步为个人学习资料，每天完成新学、到期复习和开放应用题。提交答案后查看笔记参考并自评；原答、修订和外部评阅反馈分别保留。应用运行期间不调用 AI，也不会自动把笔记或答案发给模型。

目标部署是常开的 Mac mini，通过 Tailscale Serve 提供仅个人 tailnet 可访问的 HTTPS 页面；Mac 用户登录后启动后台服务。此仓库准备了部署步骤和脚本，目标 Mac 与真实手机外网访问仍需按[部署文档](docs/deployment.md)验收。

## 本机启动

需要 Node.js **24 或更新版本**，后端使用 `node:sqlite`。本次开发机核验为 Node.js 26；新机器请用 `node --version` 确认。前端为 React 19，Vite 开发服务与后端分开运行。

先在项目目录执行：

```sh
npm ci
npm run build
IMA_REVIEW_AUTO_SYNC=1 npm start
```

打开 [http://127.0.0.1:5190](http://127.0.0.1:5190)。同步需要本机已有 ima 凭证：默认读取 `~/.config/ima/client_id` 和 `~/.config/ima/api_key` 两个纯文本文件。凭证仅后端读取，不写入前端、导出、日志或 LaunchAgent plist。也可用 `IMA_REVIEW_CREDENTIAL_DIR` 指定凭证目录；临时前台运行支持 `IMA_OPENAPI_CLIENTID` 和 `IMA_OPENAPI_APIKEY`，后台安装需使用持久的凭证文件。

开发时用两个终端：

```sh
# 终端一：后端，127.0.0.1:5190
npm run dev
```

```sh
# 终端二：界面，127.0.0.1:5189；Vite 将 /api 转发至后端
# （dev 脚本已通过 IMA_REVIEW_ALLOWED_ORIGINS 放行 5189 来源的写请求）
npm run dev:ui
```

## 每日使用

1. 首次同步后在设置中核对选择的笔记本；空题库时先检查同步状态和来源。
2. 进入今日任务，依次新学、复习和应用。新学阶段先阅读笔记并确认理解；复习阶段再用英语主动回忆，提交后查看参考并四档自评。
3. 同步新增资料进入待学池；更新资料显示重新学习提示；归档保留作答历史。只有标题而没有可用内容的条目会标记待补充。
4. 在作答档案中查看原答、修订和外部反馈。需要模型评阅时主动复制评阅包，在自己选择的工具中评阅，再贴回反馈。
5. 用 Markdown、CSV 保存可读档案，打印布局可保存 PDF；完整 JSON 或一致性 SQLite 备份用于恢复。

需要重新开始当天任务时，使用今日页面的“重置今日学习”，核对提示后确认。重置会撤销今天的新学完成与自评、删除今天新建的回答，并恢复相关词条的学习和 FSRS 状态，再随机生成今日任务；以前的历史、跨日草稿和最新笔记内容保留。日期按设置中的时区判断。重置前自动保存 SQLite 备份及完整 JSON 恢复备份；可下载页面提供的 JSON，在设置中先校验再恢复。恢复会覆盖整份学习数据，也会覆盖重置之后的新操作。

默认每天新学 10 个词条、复习 30 个词条、应用 10 题，时区 `Asia/Shanghai`，每日同步 `07:00`，网页学习待办时间 `20:30`。辨析组按一个词条计数。学习时间是网页待办提示，不是系统推送或定时发送消息。

`IMA_REVIEW_AUTO_SYNC=1` 启用启动同步与服务器内每日同步。手动同步会复用同一服务接口；同步失败显示原因并保留已有资料。后台已运行时不要再开第二个写同一数据目录的服务。

```sh
npm run sync
npm run backup
```

这两个命令请求运行中服务的 `/api/sync` 和 `/api/backups`，不会另外打开数据库。也可使用网页中的同步和备份操作。

## 配置与后台运行

数据默认在 `~/Library/Application Support/ima-review`，数据库为 `review.sqlite`，SQLite 备份在 `backups/`，重置前的 JSON 恢复备份在私有 `resets/`。数据目录必须放在 `dist`、`public` 等静态目录之外。环境变量见 [.env.example](.env.example)；`.env` 不会自动加载，前台运行和安装时请显式传入。

```sh
# 只生成预览；无需先构建，不写文件、不激活服务
node scripts/launchagent.mjs print

# 在目标 Mac 构建且核对配置后执行
npm run service:install
npm run service:status

# 停止后台服务；保留学习数据、备份和凭证
npm run service:uninstall
```

如需自定义路径：

```sh
export IMA_REVIEW_DATA_DIR="$HOME/Library/Application Support/ima-review"
export IMA_REVIEW_CREDENTIAL_DIR="$HOME/.config/ima"
export IMA_REVIEW_PORT=5190
export IMA_REVIEW_AUTO_SYNC=1
```

LaunchAgent 显式保存这些配置、绝对 Node 路径和绝对项目路径，不读取 `.zshrc`。升级 Node、移动项目或改变环境后需重新安装服务。Tailscale 身份、HTTPS origin、睡眠设置、迁移和外网验收详见[部署与恢复](docs/deployment.md)。

## 开发参考

- [接口与行为约定](docs/api.md)，类型以 `shared/types.ts` 为准，默认设置以 `shared/defaults.ts` 为准。
- [产品研究](docs/research.md)记录功能借鉴与边界。
- [Kimi 界面提示词](docs/kimi-prompt.md)可由用户自行复制运行，完成后替换 `src/`；API 和保存规则应保持兼容。
- [开发记录](docs/development-log.md)区分已确定决策和未完成的目标设备验收。

浏览器写操作验收必须使用独立临时 `IMA_REVIEW_DATA_DIR`、`IMA_REVIEW_AUTO_SYNC=0` 和其他端口，填入通用示例词条；结束后停止临时服务、清理临时数据和对应浏览器缓存。正式学习库只做只读核对，不能把测试答案写入用户记录。自动化测试使用临时目录并在结束时清理。

```sh
npm test
npm run build
node --check scripts/launchagent.mjs
```
