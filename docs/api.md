# 功能接口约定

共享类型在 `shared/types.ts`。所有响应均为 JSON，错误响应为 `{ error, code?, current? }`；修改请求以 `Content-Type: application/json` 发送。服务与前端使用同一 origin。

| 方法及路径 | 输入 | 输出 |
| --- | --- | --- |
| GET /api/settings | 无 | Settings |
| PATCH /api/settings | Partial<Settings> | Settings |
| GET /api/items | q、tag、status=active/archived/pending/all、weak=true | StudyItem[] |
| GET /api/items/:id | 无 | StudyItem |
| PATCH /api/items/:id | status=active/archived；确认资料更新 useLatest=true | StudyItem |
| GET /api/plan | 无 | DailyPlan（服务器所在设定时区的今天） |
| POST /api/practice | { itemId: string } | Question，主动重练已学词条；占每日应用题额度 |
| GET /api/stats | 无 | AppStats |
| GET /api/answers | itemId、date 可选 | AnswerRecord[] |
| PUT /api/answers/:id | AnswerInput，id 为客户端 UUID | AnswerRecord |
| PATCH /api/answers/:id | AnswerUpdate | AnswerRecord |
| POST /api/reviews | ReviewInput | { item: StudyItem, review: ReviewRecord, answer: AnswerRecord } |
| GET /api/sync | 无 | SyncStatus |
| POST /api/sync | 无 | SyncStatus；同步失败为 502 且保留旧题库 |
| GET /api/notebooks | 无 | Notebook[]（联网，来自 ima） |
| GET /api/export?format=markdown/csv/json&date=YYYY-MM-DD | date 可选 | 下载文件；json 为完整备份，其他格式为作答档案 |
| GET /api/evaluation?date=YYYY-MM-DD | date 可选 | { text: string } 可直接复制到模型窗口的评阅包 |
| GET /api/backups | 无 | BackupFile[] |
| POST /api/backups | 无 | BackupFile |
| GET /api/backups/:name | 无 | 一致性 SQLite 备份下载 |
| POST /api/restore/validate | BackupData | { valid: true, counts: { items, answers, reviews } } |
| POST /api/restore | { backup: BackupData, confirm: true } | { restored: true }；恢复前自动备份，原子替换 |
| GET /api/health | 无 | { ok: true, ... }，无凭证信息 |

## 操作约束

新学和到期复习按词条计数，辨析组为一个词条。学习阶段自评确认理解后进入当天遮住参考的复习，复习自评才更新 FSRS；新学当天首次回忆优先安排。开放回答不自动判错；提交后显示服务器保存的笔记参考，再选择四档自评。应用题自评仅记录评价，避免同一天因多题重复推进间隔。

草稿每次修改以稳定 UUID 保存，首个写入 expectedRevision=0，后续传返回的 revision。版本冲突返回 409 并提供 current，前端保留当前输入、提示冲突，不静默覆盖。提交后的 originalAnswer 不再覆盖；修订和外部反馈通过 PATCH 保存。

每日计划持久化；当天完成回忆复习的条目自动成为应用题来源，保证先学、再回忆、最后应用。用户主动重练已学词条可以直接生成应用题，仍占每日练习额度；必要时替换尚未开始的自动应用题。已开始的题目保留内容版本。新导入内容进入待学池；没有有效来源依据的高级题不生成。未完成草稿跨日沿用同一回答 ID，createdAt 保留开始时间，date 为当前待办日期。

已修改的词条 needsRelearn=true，资料更新提示中使用 useLatest 确认后重新学习。归档保留所有历史。pending 表示同步匹配歧义；需先核对，不进入每日计划。

前端请求失败必须保留未保存输入并允许重试。下载用普通链接，一键复制用用户点击触发的剪贴板操作，打印 PDF 使用专门的打印布局。
