# 长回答、个人资料库管理与权限兼容验证

日期：2026-11-07。基于当前二开工作区（起始 HEAD `0e4b6ccbd21ca5f73e0d18df3b7a6a8dcbe54dfe`），参考 `refs/upstream-tags/v2.1.0` 的 `HostBubbles.tsx` 和文件工作区设计。没有整体合并上游，也没有提交、推送或部署。

## 已实现

### 长回答渲染

- 沿用现有 HostResponseCard、Markdown、代码块和附件链接处理。
- 流式正文达到 8,000 字符后，显示层每 100ms 合并一次更新；短回答仍即时显示。
- 响应完成、失败、取消及只读历史立即显示完整正文；卸载时取消待处理定时器。
- 相同正文及交付附件信息的父级更新不再重复进入 Markdown 处理。
- SDK 事件接收、历史保存、会话分页、恢复和队列逻辑保持现有实现；没有截断回答内容。

### 个人资料库页面

- 增加按文件名/相对路径搜索、服务端分页（默认 20、上限 100）和手动刷新。此搜索不替代智能体的正文检索。
- 接入重命名、移动、删除。重命名保留目录，移动支持自动创建目标目录；页面不提供覆盖同名文件的选项。
- 删除要求页面二次确认。请求使用文档 `updated_at` 检查列表是否已经过期；冲突和权限变化给出可操作的提示。
- 移动保留文件 ID，更新当前预览路径；删除关闭当前预览。删除末页最后一项会回到有效页。
- 修复同路径移动的无意义重写，并在元数据写入或文件删除失败时恢复原文件。索引清理失败不会让已经完成的删除返回误导性失败。
- 保留上传与现有预览能力。本轮不新增内容编辑、批量删除或新的资料授权模型。

### 现有权限体系

- 新接口继续通过 `get_agent_for_request` 检查当前 Agent 使用权限，文档所属用户始终来自可信 actor。
- 查询和修改按 `owner_user_id × agent_id` 隔离；管理员身份不赋予查看、修改他人私有资料的权限。
- 仅使用成员可以管理自己的资料，不因此获得 Agent 配置编辑权限。
- 同时注册普通 `X-Agent-Id` 入口和 `/agents/{agentId}` 入口；路径/Header 冲突、撤销成员、代管标记绕过均被拒绝。
- 禁止绝对路径、目录穿越、反斜杠、符号链接及写入内部 `.qwenpaw-index` 目录。
- 切换账号或智能体时清空资料列表、管理弹窗和预览；旧请求结果不再回写新界面。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 后端资料服务、HTTP 路由、隔离策略、引用及只读工具回归 | 111 passed |
| 前端组件、API、认证续期、队列、历史分页、SDK 回放及附件链接回归 | 13 个文件，73 passed |
| TypeScript + Vite 构建 | 通过 |
| Monaco CSS 构建检查 | 通过 |
| Chromium 本地组件集成 | 通过；无 pageerror |
| 390px 窄屏布局 | 无页面横向溢出 |
| `git diff --check` | 通过 |

后端使用临时文件和内存元数据仓库；Agent 授权测试执行现有策略，成员仓储使用测试替身。浏览器使用真实 React、Ant Design、Markdown 和应用组件，拦截本地资料 API 提供测试数据。没有连接生产接口或修改生产资料，未在真实 PostgreSQL 实例上进行本轮集成验收。

长回答的确定性调度测试：100 次、间隔 10ms 的正文更新，Markdown 渲染从基线 101 次降至 11 次，并校验最终内容和结束状态。浏览器开发模式样本最终显示内容为 12,242 字符，React Profiler 累计渲染时间为基线约 1007.6ms、优化后约 160.5ms；两者均未出现超过 50ms 的 long task。此结果是单个本地样本，不代表生产端到端延迟或模型生成速度。

本地验证证据位于 `build/`（忽略目录）：

- `three-improvements-backend-final.log`
- `three-improvements-frontend-final.log`
- `three-improvements-build.log`
- `three-improvements-browser/results.json`
- `three-improvements-browser/library-desktop.png`
- `three-improvements-browser/library-conflict.png`
- `three-improvements-browser/library-mobile.png`
- `three-improvements-browser/long-answer.png`

构建仍提示若干既有依赖分块较大；本轮没有调整核心依赖或分块策略。

## 边界与后续工作

- 文件版本检查用于拒绝已经过期的操作，不等于文件系统与数据库的跨进程原子事务。同一资料的并发写入及进程突然退出恢复，仍应纳入后续“真实多人并发、异常恢复”的专项处理。
- 本轮没有升级 Worker 协议、检索重排、召回评测或业务执行器，也不宣称这些能力已获得改善。
- 按 KISS/YAGNI 保持增量改造；复用现有请求认证、路径解析、资料服务和 Markdown 实现，不增加依赖或数据库迁移。
