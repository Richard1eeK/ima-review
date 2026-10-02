# 产品研究与采用边界

核验日期：**2026-10-02**。以下六项是功能研究对象；开源项目与商业产品分别按其一手仓库或官方帮助文档判断。这里不记录未经核验的版本、Stars 或价格，也不把功能借鉴称为代码复用。

| 对象 | 可借鉴能力 | 本项目的取舍与限制 | 一手来源 |
| --- | --- | --- | --- |
| Anki | 每日新卡/复习上限、FSRS 间隔、四档自评、导出历史 | 采用每日上限和自评流程；输入来自 ima 的词汇、短语和辨析组，不直接套用通用卡组。开放答案需要参考和自评，不能只比较字符 | [电脑端源码](https://github.com/ankitects/anki)、[Deck Options](https://docs.ankiweb.net/deck-options.html)、[Exporting](https://docs.ankiweb.net/exporting.html) |
| ts-fsrs | TypeScript FSRS 调度器，返回更新后的卡片与复习日志 | 直接使用 MIT 许可调度库；它只负责排期，不提供应用界面、笔记解析或语义评阅。学习/复习自评推进排期，应用题仅记评价 | [官方仓库与 MIT 许可](https://github.com/open-spaced-repetition/ts-fsrs) |
| Logseq DB 版 | 笔记块加 `#Card`，查看 `Due`，用四档评价安排复习 | 借鉴“题目保留来源上下文”；本应用保留笔记本、笔记与内容块引用。研究以当前 DB 版文档为准，不把旧文件图谱的配置和行为混进来 | [DB 版说明：Cards](https://github.com/logseq/docs/blob/master/db-version.md#cards) |
| Qwerty Learner | 通过键盘输入练习英语单词与拼写，适合词形和输入熟练度 | 借鉴低干扰输入体验。它的主要练习目标是词形与打字记忆，不能据此替代解释、辨析、造句、语域和常见误用练习，也不据其界面推定语义 SRS | [官方源码与说明](https://github.com/RealKai42/qwerty-learner) |
| RemNote | 输入答案、每日目标与学习进度、导出和打印；输入可按精确、模糊或 AI 方式评阅 | 商业闭源产品。采用输入作答、每日目标、档案和打印思路；本项目运行时无 AI，不继承其自动评分、AI 配额或付费能力 | [Typing in Answers](https://help.remnote.com/en/articles/7752298-typing-in-answers)、[Goals and Streaks](https://help.remnote.com/en/articles/7950933-goals-and-streaks)、[Exporting and Printing](https://help.remnote.com/en/articles/7898019-exporting-and-printing-notes) |
| Mochi | Markdown 内容、间隔复习、原生完整导出与 Markdown/CSV 导出 | 商业闭源主应用。借鉴可读导出与完整备份的分层：Markdown/CSV/PDF 用于查看，JSON/SQLite 用于恢复。其官方 Open source 链接指向相关集成，不能证明主应用可自托管或源码开放 | [Reviewing](https://mochi.cards/docs/reviewing/)、[Exporting](https://mochi.cards/docs/import-and-export/exporting/)、[官网](https://mochi.cards/) |

以上取舍是本项目的设计判断。它们支持“同步笔记 → 每日计划 → 独立作答 → 参考与自评 → 历史档案”的工作流，不构成这些产品与本项目功能等价的证明。

高级题只使用来源中已有的解释、例句、语域和误用依据。资料不够时显示待补充或不生成对应题型，避免用运行时 AI 填补内容。外部评阅由用户主动复制资料后自行执行，应用仅保存用户贴回的反馈。
