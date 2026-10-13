# 本地频道、Slash 与图片技能调整 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for scoped implementation and review. User constraints override Git, deployment and commit steps in generic skill workflows.

**Goal:** 仅在本地完成频道个人绑定隔离、五种连接器展示、Slash 对齐、应用机制说明和 imagegen 默认策略调整。

**Architecture:** 保留现有个人频道绑定机制，统一收窄前端展示并修复监听器私有运行目录；Slash 统一图标占位；imagegen 通过技能池版本生命周期发布并更新已有安装，保留私有配置。

**Tech Stack:** Python、PostgreSQL、React/TypeScript、现有 OpenAI 兼容图片代理。

## Global Constraints

- 不部署服务器，不创建分支，不执行 Git 提交、推送或重置。
- 保留工作区已有修改；仅更新本任务相关内容。
- 频道界面仅保留“我的频道”；仅展示钉钉、飞书、微信、企业微信和 QQ。
- 同一个智能体下，不同用户的绑定、监听器缓存和媒体必须隔离；不向真实频道发送测试消息。
- 图片默认使用 gpt-image-2.5-sunburst；用户明确要求快速时使用 gpt-image-2.5-flare。
- 优先采用接口实际支持的高质量和 4K 尺寸；不将 xhigh 等未经支持的参数传入图片 quality 字段。
- 不输出密码、访问令牌、订阅地址或技能私有配置。
- 不修改历史不可变技能快照；通过现有生命周期发布新的技能版本。

## Task 1: 频道展示和个人绑定隔离

- [x] 隐藏智能体频道和非指定连接器。
- [x] 检查按用户绑定的存储、运行时和会话归属。
- [x] 修复共用监听器文件目录，验证同一智能体下双用户隔离。
- [x] 执行相关频道回归测试并记录结果。

## Task 2: Slash 对齐与应用机制说明

- [x] 统一菜单命令图标槽，保持标题和说明缩进一致。
- [x] 验证无图标和有图标命令的共同布局。
- [x] 依据应用中心、插件加载、共享应用和运行时代码说明安装效果。

## Task 3: imagegen 模型与默认质量策略

- [x] 检查真实技能池目录、当前版本、模型列表和脚本参数。
- [x] 调整模型选择及高质量默认值，覆盖新模型尺寸校验。
- [x] 验证请求参数，不进行付费图片生成。
- [x] 通过正常技能发布与安装更新流程，使已有引用生效并保留私有配置。

## Task 4: 本地集成验证

- [x] 审查本任务变更，修复重要问题。
- [x] 构建 console，运行相关后端和脚本测试。
- [x] 重新运行本地服务，检查健康状态、静态文件和技能版本。
- [x] 记录实际验证范围和剩余限制，不宣称未完成的视觉或真实生图验证。
