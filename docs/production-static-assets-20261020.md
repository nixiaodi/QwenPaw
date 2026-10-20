# 线上刷新空白与静态资源传输调整

## 现象与定位

线上 `/skill-pool?tab=published` 刷新时整个页面空白，包括侧栏。外网检查页面 HTML 和认证状态接口均在约 0.5 秒返回 200；首页脚本 `index-B-GHHz6M.js` 为 13,676,536 字节，未压缩完整下载耗时 23.55 秒，且没有静态资源缓存策略。前端脚本初始化之前根节点为空，造成明显的白屏等待。

## 调整

- 增加 `deploy/nginx/agent-static-assets.conf`，在 HTTPS `server` 块内配置 `/assets/` 专用代理。
- 对 JavaScript、CSS 等静态资源启用 gzip 压缩，并添加 `Vary: Accept-Encoding`。
- 对带内容哈希的资源使用 `public, max-age=31536000, immutable` 浏览器缓存；404 不附加长期缓存。
- 首页继续使用 `no-cache, no-store, must-revalidate`，认证 API 不增加静态缓存策略。
- 线上配置先备份，再执行 `nginx -t` 和平滑 reload；原配置备份位于 `/var/lib/weldonagent/backups/nginx-assets-20261020T144314Z/`。

## 结果与边界

同一外网环境复测：脚本实际传输量降为 3,850,227 字节，耗时 6.44 秒，解压后的 SHA-256 与已部署构建清单一致。实际传输量减少约 72%，后续普通刷新可复用缓存。页面 HTML、认证状态接口仍返回 200，缺失资源返回 404 且不长期缓存。

以上耗时为一次外网测量，会随用户网络变化。它确认并修复了已发现的资源传输瓶颈；没有将未登录浏览器的登录页检查视为已登录技能池界面验收。

参考：[Nginx gzip 模块](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)、[响应头模块](https://nginx.org/en/docs/http/ngx_http_headers_module.html)。
