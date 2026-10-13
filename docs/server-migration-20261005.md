# 服务器迁移记录（2026-10-05）

服务器：`SERVER_PUBLIC_IP`，Ubuntu 26.04 x86_64，8 核、约 30 GiB 内存、79 GiB 系统盘。迁移后约 50 GiB 磁盘可用。

## 当前访问状态

- 服务器内部应用、Nginx 和模型调用均已通过验证。
- 公网入口为 `http://SERVER_PUBLIC_IP/`。腾讯云放行 TCP 80 和 443 后复测：首页返回 HTTP 200，认证状态接口返回多用户模式且已有用户，应用容器健康，Nginx 与 Mihomo 正常运行。
- 本机临时 SSH 隧道入口：`http://127.0.0.1:18090/`。已打开并确认显示 WeldonAgent 登录页。此入口仅在本机 SSH 隧道运行时可用。
- 项目使用迁移前的用户账号和密码；服务器 root 凭据不作为项目登录凭据。
- 已配置域名入口 `https://agent.example.com/`，域名 HTTP 请求以 308 跳转到 HTTPS；公网 TLS 证书验证通过，浏览器显示项目登录页。
- 原本机应用保持停止，防止两个实例继续写入不同数据。原本机数据库、文件和完整备份均保留。

## 已迁移和验证的数据

源实例停止后生成 PostgreSQL 一致性备份及文件归档。上传后逐个归档核验 SHA-256，再恢复数据库和文件。

| 数据 | 迁移时数量 | 验证结果 |
| --- | ---: | --- |
| PostgreSQL 业务表 | 59 | 各表记录数与源库一致 |
| 用户 | 2 | 权限会话、Agent 列表通过 |
| Agent | 8 | 全部 QwenPaw 后端，工作目录已适配 Linux |
| 原有对话 | 19 | 全部历史读取通过 |
| 原有消息 | 1,071 | 已恢复 |
| 原有运行事件 | 152,963 | 已恢复 |
| 聊天附件 | 4 | 全部下载成功 |
| 已登记产物 | 64 | 全部下载成功，内容 SHA-256 与数据库一致 |
| 个人资料库文件 | 2 | 下载及内容 SHA-256 通过 |
| 技能池条目 / 版本 | 7 / 7 | 数据库及文件归档已恢复 |
| Agent 技能关系 | 9 | 已恢复 |

用户配置、技能资源、历史运行文件、日志、模型配置、加密主密钥、CLIProxyAPI 的配置及授权文件已迁移。仅运行配置与必要的数据库路径字段由 Windows 工作目录映射到 `/data/working`；已登记产物及技能快照保留原始内容。

逐文件与原始工作目录归档对比：2,261 个原文件无缺失，2,221 个文件字节完全一致；40 个发生变化的文件为路径适配后的配置、运行日志、验收产生的会话状态及服务启动重新生成的记忆索引等运行文件。原始归档保留，可追溯比较。

验收额外创建了一条「服务器迁移连通性验证」对话：完整应用发送、流式回答、历史读取通过，并已归档。因此验收后数据库含 20 条对话，新增测试消息和运行事件属于正常验收写入。临时验收会话令牌均已撤销。

## 服务与目录

| 服务 | 运行方式 | 监听 |
| --- | --- | --- |
| 网页入口 | Nginx | `0.0.0.0:80` |
| WeldonAgent | Docker `agent-app` | `127.0.0.1:18089` |
| PostgreSQL 16 | Docker `agent-pg` | `127.0.0.1:5432` |
| 模型代理 | Docker `weldon-model-proxy` | `0.0.0.0:8317`（用户要求开放公网） |
| Clash/Mihomo | systemd `mihomo` | `127.0.0.1:7890` |
| Mihomo 控制接口 | 同上，带认证 | `127.0.0.1:9090` |

源码、部署脚本：`/opt/weldonagent`。持久数据：`/var/lib/weldonagent`。完整迁移备份：`/var/lib/weldonagent/backups/backup`。

部署编排：`/opt/weldonagent/compose.server.yml`。服务配置：`/opt/weldonagent/deploy/service.server.json`。数据库密码保存在仅 root 可读的 `/opt/weldonagent/deploy/.env.server`，不写入本文。

Python 3.11、Node.js 22.22.1、Chromium、中文字体、LibreOffice、FFmpeg、Poppler、Tesseract 及文档 Python 依赖已安装。浏览器实际启动、文档模块导入和 `pip check` 通过。原配置中的 MCP 客户端未启用，迁移过程保持原状态。

`requirements.runtime.lock.txt`、`application-image.id`、`file-integrity.json` 保存在服务器 `deploy` 目录，可用于核对运行环境与迁移文件。

## 代理配置

已登录并核对 代理服务商「第三方客戶端下載」页面。其 Ubuntu 下载项为 Clash Verge Rev 2.5.1 amd64 DEB 桌面客户端。服务器没有图形桌面，因此运行对应的 Mihomo 后台核心，版本 v1.19.32，官方发行文件校验通过。

当前节点来自本机正在运行的 Clash 配置。代理 GitHub 请求返回 200，Docker Registry 连通验证通过，CLIProxyAPI 实际模型调用返回 200，模型列表返回 11 个模型。

`/etc/mihomo/config.yaml` 与 `/etc/mihomo/subscription.yaml` 为 root 专用文件。原订阅地址尝试刷新返回 HTTP 错误，当前使用已迁移节点配置，尚未启用订阅自动刷新；后续应从账户后台取得有效订阅地址再更新。部署的大部分 Python 依赖已改走服务器直连镜像。

## 运维命令

在服务器执行：

```bash
cd /opt/weldonagent
docker compose --env-file deploy/.env.server -f compose.server.yml ps
docker compose --env-file deploy/.env.server -f compose.server.yml restart agent-app
systemctl status mihomo nginx --no-pager
curl -s http://127.0.0.1/api/auth/status
```

Docker、Nginx、Mihomo 已设置开机启动，应用、数据库与模型代理容器设置自动重启。应用健康检查正常。

公网 HTTP 和域名 HTTPS 均已验证可访问，TCP 443 已启用 TLS 监听。数据库与 Clash 保持本机回环监听。HTTPS 证书对应域名，使用 `https://agent.example.com/` 访问。

## 域名与 HTTPS 配置

2026-10-05 按用户要求配置 `agent.example.com`，A 记录指向 `SERVER_PUBLIC_IP`。复用已有 Nginx 1.28.3，新增站点 `/etc/nginx/conf.d/agent.example.com.conf`，无需另安装 Nginx。

证书来自用户提供的 `27636796_agent.example.com_nginx` 目录，服务器路径为 `/etc/nginx/ssl/agent.example.com/agent.example.com.pem` 和同目录的 `.key`。目录权限 700，文件权限 600。证书链及证书与私钥匹配检查通过，启用 TLS 1.2/1.3。

域名 HTTPS 反向代理到现有应用 `127.0.0.1:18089`，沿用原代理的流式响应、WebSocket、上传限制和长请求超时设置。域名 HTTP 以 308 保留路径跳转到 HTTPS。原 IP HTTP 入口保留。CLIProxyAPI 8317 入口未在此变更中调整。

证书到期时间为北京时间 **2027-01-03 07:59:59**，当前使用手动提供的证书，尚未配置自动续期。到期前需替换证书和私钥，执行 `nginx -t` 后热重载。

成功应用前的 Nginx 配置及验证结果备份于 `/var/lib/weldonagent/backups/nginx-tls-20261005T135955Z/`。配置语法检查和热重载通过；服务器回环及本机公网访问均通过可信证书验证；HTTPS 首页返回 200，认证接口正常，HTTP 跳转返回 308。浏览器实际显示 `https://agent.example.com/login?redirect=%2F` 登录页，无证书警告。

## CLIProxyAPI 公网入口调整

用户明确要求调整后，将模型代理配置中的 `host` 从 `127.0.0.1` 改为 `0.0.0.0`，重启 `weldon-model-proxy`。既有 API 密钥、管理密钥和鉴权配置保留；修改前配置保存在 `/var/lib/weldonagent/model-proxy/config.before-public-8317.yaml`，权限为 600。

已通过腾讯云浏览器控制台确认上海地域的安全组 `sg-REDACTED` 关联实例 `ins-REDACTED` / `SERVER_PUBLIC_IP`，TCP 80、443、8317 入站均允许。

公网首页和 `/management.html` 返回 200；未携带密钥请求 `/v1/models` 和 `/v0/management/config` 均返回 401。浏览器已显示公网管理登录页：`http://SERVER_PUBLIC_IP:8317/management.html#/login`。使用原管理密钥登录；该密钥与项目登录密码、模型 API 密钥及服务器 root 密码是不同凭据。

## CLIProxyAPI 管理页面兼容修复

后端保持 v7.2.143。此前管理页面自动更新到要求 v8 的版本，造成登录时报告接口不兼容。用户确认后，改用官方管理页面 v1.22.9，其最低后端要求为 7.1.0，使用 `/v0/management` 接口。

下载文件 SHA-256 为 `769b154ba9c8c8b92d3eefd0cb9bb6271307f68f04e583002696527acf87ad86`，与官方发行记录一致。配置设置 `remote-management.disable-auto-update-panel: true`，Compose 将管理页面只读挂载到 `/CLIProxyAPI/static/management.html`，避免自动更新或容器重建后再次出现版本不匹配。

原配置、原 Compose、原页面及校验结果保存在 `/var/lib/weldonagent/model-proxy/panel-fix-v1.22.9/`。现有 API 密钥、管理密钥与授权文件保留。只重建模型代理容器，未升级后端。

应用后验证：服务运行正常；HTTP 管理页面内容校验通过；管理接口无凭据返回 401；模型列表有 11 项；`gpt-6.1-sol` 真实生成请求通过。浏览器已刷新到兼容的中文登录页，不再显示 v8 要求。用户仍需使用原管理密钥登录；未代填密钥，未验证用户登录后的完整管理操作。

## 前端补充修复

修复深链接切换对话时短暂挂载旧 Agent，以及解析完成后用户切换 Agent 导致一直转圈的问题。使用当前对话和可访问 Agent 列表计算解析状态，保留后续正常的 Agent 切换流程，避免重复维护两份解析状态。

两个新回归测试先复现错误，再验证修复；连同已有的 Agent 解析与产物链接测试共 13 项通过。TypeScript 和生产构建通过，Monaco CSS 校验通过。修复后的前端已部署到服务器镜像。

未执行 git 提交、推送或创建分支。

## 2026-10-06 对话状态与 PDF 下载修复

对话 `REDACTED_UUID_1` 的 PDF 真实存在，4 页，116834 字节，已登记为站内产物 `REDACTED_UUID_2`。文件发送工具返回 `/api/console/artifacts/REDACTED_UUID_2/download`，最终助手回复却写入了不对应该产物的 OSS 链接。此链接并非文件发送工具返回的地址，不是迁移时配置了 OSS。

生成脚本第一次因缺少 ReportLab 样式名称参数失败，随后模型修复并成功生成文件。最后一个检查命令因容器缺少 `file` 工具返回 127，尽管 PDF 已成功生成和发送，仍留下工具失败状态。多用户运行状态按可信用户身份隔离，但 Runtime 收尾通知缺少身份且发生在最终响应之后，导致该用户的状态缓存没有清除。

修复内容：Runtime 在最终响应发出前，以服务端可信 actor 身份清理运行状态，保留异常和取消路径的收尾处理；Shell 非零退出和执行异常标记为错误；前端从本轮成功的 `send_file_to_user` 返回值提取真实产物地址，匹配对应文件标题的下载链接并使用站内鉴权下载，不改变无关外部资料链接；文件卡片显示解码后的中文文件名。容器补充 `file` 工具。

部署中另修复 POSIX 端口预检把 TIME_WAIT 误判为占用的问题：仅 POSIX 的探测 socket 使用 SO_REUSEADDR，Windows 保持原检查方式；真正的活动监听冲突仍拒绝启动。

应用镜像为 `weldonagent:report-fix-20261006-v2`，仅重建应用容器，数据库与代理配置不变。重启前确认无 queued/running Run。备份目录 `/var/lib/weldonagent/backups/report-fix-20261006T070551Z/` 保存切换前 Compose、镜像 ID 和修改前源码；此前迁移镜像仍保留。

验证：相关后端测试 107 通过、13 个平台相关测试跳过；新增端口检查与现有服务测试等 22 项通过；前端相关测试 12 项通过；TypeScript、生产构建和 Monaco CSS 检查通过。候选镜像隔离验证覆盖用户状态清理、其他用户状态保留、非零 Shell 错误和实际 TIME_WAIT 端口复用。线上真实失败工具调用后会话 idle、运行状态为 null，验证对话已归档，临时会话令牌已撤销。

原对话运行状态接口现返回 null；真实 PDF 的鉴权下载返回 200，SHA-256 为 `6a729f9c0890155c054e312017ff0a1aba6f613d5ab0b1951273715f88a14fc2`，内容未修改。用户刷新前端后可使用修正后的站内下载链接；数据库中的历史模型文本作为原始记录保留。公网前端首页 SHA-256 为 `201b07f0e1567d13a9ebcf144021b2e8264c880c25b39c45dde57bd7f1ae95b4`。

### 2026-10-08 Mihomo 管理面板

已安装官方 MetaCubeXD gh-pages 静态面板，配置目录 `/etc/mihomo/ui-20261008T083715Z`。管理接口监听 `0.0.0.0:9090`，入口 `http://SERVER_PUBLIC_IP:9090/ui/`；代理端口7890仍仅监听本机。沿用原管理密钥，未认证API返回401。美国04｜洛杉矶节点选择保留，配置开启store-selected。

安装前配置备份：`/var/lib/weldonagent/backups/mihomo-panel-20261008T083715Z/config.yaml`。管理连接资料在服务器 `/root/mihomo-panel-access.txt`（600）及本机ignored迁移目录同名文件，本文不记录密钥。服务器本地面板200且代理连通性204；公网9090测试超时，腾讯云控制台登录已过期，需要重新登录核查安全组并放行TCP9090。当前入口为HTTP，管理密钥传输无TLS保护。

### 2026-10-08 智能体切换与 Chat not found 复发修复

对话 `REDACTED_UUID_3` 属于 designer，数据未删除；所属用户在 designer 上下文可读历史53条，new-media上下文对同一对话返回404。日志记录失败POST前模型目录为new-media，符合请求智能体与会话不一致的权限拒绝。

遗漏路径：ChatRoute仅缓存已解析的URL，不比较已解析智能体与当前选择，导致切换后仍挂载旧会话；从技能等智能体页面返回聊天时，恢复旧链接又会按旧会话重选智能体；SessionApi未在切换入口清除lastActive/preferred/window identity，仅靠聊天页effect，未挂载时清理不会执行。

修复：统一侧栏聊天导航携带当前智能体意图（折叠/展开/简单模式）；路由在返回或切换时仅恢复当前智能体可访问的会话，无有效目标则进入当前智能体新聊天页面；不以旧会话反向覆盖显式选择；上下文不匹配期间不挂载ChatPage，取消过期异步结果；切换统一入口同步清除旧恢复目标和传输标识。直接打开对话链接仍按授权列表解析所属智能体。权限校验不放宽，不移动或删除用户会话。

回归验证：8个测试文件99项通过，新增真实MemoryRouter+Zustand路径测试3项通过（102项不同测试）；最终关键3文件31项再次通过。TypeScript/生产构建与Monaco样式检查通过。生产镜像 `weldonagent:chat-agent-fix-20261008`，更新前无queued/running运行，健康检查通过。备份 `/var/lib/weldonagent/backups/chat-agent-fix-20261008T092138Z`。公网HTTPS200，首页SHA256 `1513b5fdc5ccf651741af43db00b26ad507c80ba5a76697b6bf47403c09bdb10` 与构建产物一致。未使用真实用户浏览器登录验证，浏览器需刷新获取新静态版本。

### 2026-10-08 图片技能执行与新会话闪动修复

原对话 `REDACTED_UUID_4` 属于 designer。该轮工具调用记录为空，助手只输出“已生成成都城市宣传海报”；没有实际执行生成。服务器上的 imagegen 已安装且启用，Image API 鉴权正常，模型列表包含 gpt-image-2。技能意图路由仅存在于旧 AgentRunner，实际线上使用 Runtime/AgentBuilder，未接入同一意图路由。

修复：AgentBuilder 按当前智能体、频道和有效技能范围自动路由并加载完整技能指令，复用显式加载的路径说明；图片任务首轮使用 AgentScope 原生 ToolChoice(mode="required")。工具执行中间件记录本轮 image_gen.py 成功执行及图片成功发送的结果，完成校验不依赖会被 Scroll 压缩的模型上下文；兼容原生媒体块和适配层 JSON 编码结果。没有完成交付时阻止虚假完成文字输出与持久化，有限继续尝试后明确报告未完成，保留已有停止预算。图片命令提示使用300秒超时。

新会话首条消息取得后台UUID时，ChatRoute将聊天组件替换为Spin，造成组件卸载与状态丢失。路由现在识别当前智能体已由后台响应确认的会话ID，在ID更新时保持聊天组件挂载；未知深链接和跨智能体跳转仍执行原权限范围解析。

验证：真实 MemoryRouter/Zustand/SessionApi 回归测试先复现同一聊天挂载两次，修复后保持一次且输入状态保留；前端4文件34项通过，TypeScript、生产构建和Monaco CSS校验通过。后端相关测试112项通过、1项跳过，覆盖虚假完成流拦截、旧轮次证据隔离、执行失败、JSON结果及上下文压缩后证据保留。

生产镜像 `weldonagent:poster-fix-20261008-v4` 已部署且健康，重启前无queued/running运行；备份 `/var/lib/weldonagent/backups/poster-fix-20261008T110437Z`。前端首页SHA256 `6fc4db7c43cfdbe2436e7ed6f502f4041ba4b175a6f281739a2ff988e1957644`。更换应用镜像，未修改数据库结构、原用户会话或代理配置。自动加载技能与交付校验使用独立职责组件，技能指令复用既有加载实现。

最终线上完整验证对话 `REDACTED_UUID_5`：实际执行图片脚本、检查文件、预览图片并发送，6次工具调用完成，1个登记产物，正常返回idle；完成校验接受成功交付，没有继续误判。生成耗时51.8秒；站内产物 `REDACTED_UUID_6` 鉴权下载200，PNG尺寸941×1672，2936408字节，Pillow文件完整性检查通过。诊断会话已归档，临时认证令牌已撤销。最终公网首页200且SHA256与构建一致。浏览器停留登录页，未声称已用真实登录态复现；闪动验证使用真实前端路由与会话状态回归测试。
