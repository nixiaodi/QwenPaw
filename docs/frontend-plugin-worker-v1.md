# 前端插件迁移到 worker-v1

本地版本采用严格的独立线程执行策略。插件 JavaScript 只在 Dedicated Worker 内执行；主页面只渲染经过校验的数据，不接收插件提供的 React 组件或回调函数。旧前端插件需要适配，不能只修改版本声明。

## 清单与入口

在插件 `plugin.json` 中声明：

```json
{
  "id": "counter-demo",
  "name": "计数示例",
  "version": "1.0.0",
  "entry": {
    "frontend": "index.js",
    "frontend_runtime": "worker-v1"
  }
}
```

缺省值是 `legacy`。未适配插件的前端脚本不会下载或执行，页面显示需升级提示；后端工具是否可用仍由原有插件配置和授权决定。浏览器不支持 Worker 时也不降级到主线程执行。

入口应打包为独立 JavaScript 模块；模块由 Blob URL 导入，不支持依赖页面 DOM、`window`、宿主 React 或相对路径分包。不要继续使用 `window.QwenPaw`、组件注入、直接修改主页面或获取主页面令牌的方式。

## 可运行的入口示例

```javascript
let count = 0;

QwenPawWorker.registerRoute({
  id: "counter",
  path: "/plugin/counter-demo",
  label: "计数示例",
  render(input, event) {
    if (event?.action === "add") count += 1;
    return {
      tag: "section",
      children: [
        { tag: "p", text: `当前计数：${count}` },
        { tag: "button", text: "增加", action: "add" }
      ]
    };
  }
});
```

工具卡片使用同样的数据协议：

```javascript
QwenPawWorker.registerTool({
  id: "result",
  tool: "my_tool",
  render(input) {
    return { tag: "pre", text: JSON.stringify(input, null, 2) };
  }
});
```

`render` 可返回 Promise。注册必须在入口模块初始化结束前完成；定时器中迟到的注册会失败。每个插件最多注册 50 项，ID 和目标不能重复，路由只能位于 `/plugin/<插件 id>` 及其子路径。

界面允许文本、标题、段落、列表、表格、代码、按钮和输入框等基础节点。属性只接受 `tag/text/children/action/value/placeholder/disabled`；HTML、任意事件函数和任意属性不会进入宿主。按钮把 `action` 发回 Worker；输入框还会发送 `value`。每次响应最多 1000 个节点、20 层、128000 个字符。

工具参数会删除函数、React children 和循环引用，并限制深度、节点数、字符串长度及总字符量。插件不应依赖收到完整大文件或完整工具输出。

## 请求后端

```javascript
const result = await QwenPawWorker.request("/status");
// 对应 /api/plugins/counter-demo/status
```

宿主负责附加当前账号和智能体的请求头。插件后端需要通过现有 `register_http_routes` 接口，将自己的路由注册在 `/plugins/<插件 id>` 前缀下；旧插件的自定义顶层前缀需要一并适配。宿主代理只接受当前插件的相对路径，最多 4 个并发请求，8 秒超时，请求体上限 128000 个字符。切换账号或智能体后，旧请求会取消，迟到结果不会返回给新上下文。

## 失败与生命周期

- 清单和脚本下载分别有 8 秒超时；基础菜单和聊天不等待插件启动。
- Worker 初始化超过 8 秒、一次渲染超过 5 秒，直接 `terminate()`，清除注册项并提示。
- 前台通过心跳检测后台卡死的 Worker；失联约 10–12 秒后停止。隐藏标签页暂停心跳判定，避免浏览器节流误杀。
- 注销或切换账号终止旧 Worker、取消请求，并拒绝旧加载批次的迟到注册。
- 已停止的插件可在刷新页面后重新加载。

这是执行线程和页面渲染隔离，不是面向恶意代码的操作系统安全沙箱。Worker 仍具有浏览器提供的网络等能力，也会消耗设备 CPU/内存；不要把该机制描述为可以安全运行任意不可信代码。关于 Worker 的终止语义及数据传递限制，见 [MDN Worker.terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate) 和 [结构化克隆算法](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)。
