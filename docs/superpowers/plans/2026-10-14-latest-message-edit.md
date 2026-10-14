# 最新用户消息编辑与重新发送实施计划

> 执行方式：在当前会话内逐项实现、测试和复核；遵循 writing-plans 与 test-driven-development。用户已确认交互与实现方案。

**Goal:** 用户可以编辑自己会话的最新用户消息，在等待、生成、停止和完成状态下重新执行这一轮。

**Architecture:** 保留 PostgreSQL 原始轮次，使用 superseded 状态形成有效历史投影。统一 Console 提交入口协调停止、修订和新运行；每轮保存执行前上下文，用运行版本阻止旧快照覆盖。前端在消息气泡中提供编辑器，继续使用现有流式提交链路。

**Tech Stack:** Python/FastAPI、PostgreSQL、JSON 会话快照、SQLite Scroll 历史、React/TypeScript、现有 AgentScope 聊天组件。

## 约束

- 仅最新用户消息可编辑，后端校验会话所有权和预期消息 ID。
- 同一会话、智能体、模型和原附件默认保持；取消编辑不停止生成。
- 重新发送后，旧轮次退出展示和模型上下文；已发生的工具外部操作保留。
- 修订请求 ID 幂等，多标签页过期编辑返回 409，失败保留编辑草稿。
- 旧审批随任务停止失效；旧流与后台保存不能进入新轮次。
- 本地开发和验证；本次不执行 Git 提交、推送及生产部署。

## Task 1：上下文边界与保存版本

文件：`src/qwenpaw/app/chats/session.py`、`src/qwenpaw/hooks/session/session_hook.py`、`src/qwenpaw/runtime/runtime.py`、`src/qwenpaw/agents/context/scroll/history.py`。

- [x] 在 `tests/unit/app/chats/test_session_turns.py` 验证：保存执行前快照、恢复此前上下文、过期运行保存被拒绝、不同用户及会话隔离。
- [x] 执行测试确认缺失行为，再增加 `begin_turn`、`restore_turn` 与带 `run_id` 的保存校验。
- [x] 为 Scroll 投影提供按会话与边界序号截断的方法，测试其它会话不受影响、FTS 不再召回被替代内容。
- [x] 正常保存和取消保存都携带服务端运行 ID。

## Task 2：修订事实与执行协调

文件：`src/qwenpaw/app/chats/turn_edit.py`、`src/qwenpaw/app/chats/repo/postgres_repo.py`、`src/qwenpaw/app/chats/run_persistence.py`、`src/qwenpaw/app/chats/api.py`、`src/qwenpaw/app/task_tracker.py`、`src/qwenpaw/app/routers/console.py`。

- [x] PostgreSQL 实测：只替代最新用户轮次，原记录保留，旧消息 ID 冲突，重复请求只产生一次新运行，附件归属保留，跨用户拒绝。
- [x] 有效历史排除 superseded，序号分配仍考虑全部审计记录。
- [x] 在 Console 统一入口识别 `edit_last_message`，串行协调验证、停止、上下文恢复和新运行；普通提交与修订使用同一会话提交锁。
- [x] 重复修订附着既有运行；终态重复请求回放原运行事件，不重新调用模型。
- [x] 测试正在执行、等待启动、停止及完整回答的重发路径；清理旧审批。

## Task 3：气泡编辑器与流式重发

文件：`console/src/pages/Chat/latestMessageEdit.ts`、`console/src/pages/Chat/components/LatestMessageEditor.tsx`、`console/src/pages/Chat/HostBubbles.tsx`、`console/src/pages/Chat/index.tsx`、相关国际化文件。

- [x] 测试最新消息选择、附件保留、取消不修改原消息、空内容校验和重复提交。
- [x] 最新用户消息旁增加铅笔；显示原位文本编辑器、取消、重新发送及等待状态。
- [x] 编辑重发绕过普通排队，隔离旧流，局部更新消息列表并接入既有 SSE 处理，保持路由与聊天组件稳定。
- [x] 切换会话或智能体时结束编辑；只读聊天和不支持修订的后端不显示入口。

## Task 4：本地验收

- [x] 运行相关后端与前端测试、类型检查和前端构建。
- [x] 在本地服务验证生成中重发、完成后重发、附件、刷新和过期编辑冲突；真实模型验证完成后重发及终态幂等回放。
- [x] 复核 Git 差异，保留此前应用安装修复与未跟踪证书目录。
- [x] 记录验收证据和已发生工具操作不会自动撤销的边界。

验收明细见 `docs/latest-message-edit-verification-20261014.md`。复核补齐了首轮 Scroll 水位、启动前持久化、旧轮次保存隔离、失败草稿缓存、切页时待发送状态清理及终态回放结束标记。
