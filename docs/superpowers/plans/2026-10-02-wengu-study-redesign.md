# 温故 · 书房水墨重设计 Implementation Plan

**Goal:** 不动业务逻辑，将 ima-review 前端重塑为"书房水墨"气质的中国风学习空间，补齐细腻交互动效与响应式细节。

**Architecture:** 全面重写 `src/styles.css`（设计系统），对组件做最小结构补丁（仅表现层）。逻辑、hooks、API 调用一律不改。

**Tech Stack:** React 19 + TypeScript + 纯 CSS（无新依赖）。

## 设计决策（已确认）

- **场景**：晚间书桌一盏台灯，翻开宣纸手册温故。亮色调纸面。
- **色彩**：Restrained。宣纸底 + 松烟墨文字，黛绿行动，朱砂仅限印章点缀（≤5%）。
- **字体**：中文标题 `Songti SC/Noto Serif SC`；英文正文 `Palatino/Georgia`（16px/1.85）；UI 系统黑体。
- **动效**：仅 transform/opacity，ease-out（cubic-bezier(.22,1,.36,1)），150–300ms；级联 prefers-reduced-motion 与设置项 reducedMotion。
- **禁用**：禁止 >1px 侧边色条；禁止渐变字、玻璃拟态。

## Tasks
- [x] Task 1 设计令牌与基础（OKLCH 令牌、字体栈、焦点环、静态纸纹）
- [x] Task 2 侧栏与导航（朱砂印章、竖排"溫故知新"、移动底部导航）
- [x] Task 3 学习页（衬线大数字、中文序号页签、队列、卡片、保存态墨点呼吸、四档自评）
- [x] Task 4 词库/档案/同步/设置页
- [x] Task 5 状态与组件补丁（三点笔锋 Loading、圆印空态、全边框通知、中文序号、竖排装饰）
- [x] Task 6 响应式与打印（1150/850/620 断点、A4 排版）
- [x] Task 7 验证（build、test、vite、截图核对）
