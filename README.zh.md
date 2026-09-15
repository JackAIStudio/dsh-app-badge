# dsh-app-badge

DeepSeek Harness 原生应用角标（Dock / Taskbar Badge）与后台任务完成通知插件。

提供类似 ChatGPT、Slack 等桌面客户端的未读通知数字与红点角标体验。

---

## 🌟 核心特性

- **macOS 原生 Dock 角标**：在 Chrome App (PWA) 或 JackDSH 桌面端中，任务完成或等待审批且窗口处于后台时，Dock 图标右上角显示红底白字数字角标。
- **智能失焦感知**：
  - 用户正看着窗口时，不打扰、不累积角标；
  - 用户切到其他应用或最小化窗口时，长任务跑完或出现审批中断，角标自动累加（`1`, `2`...）；
  - 用户点击切回窗口（`focus` / `visibilitychange`）瞬间，角标自动清零并同步服务端状态。
- **多端与跨平台兜底**：
  - **JackDSH 桌面端**：走 `window.jackdshNative` 原生桥，直接点亮 Dock / 任务栏红点；窗口聚焦自动清零。不弹系统横幅、不弹跳图标、不申请通知权限。
  - **Chrome PWA / Web App**：调用标准 `navigator.setAppBadge`（JackDSH 内也会 polyfill 到同一条原生桥）。
  - **普通浏览器标签页**：优雅降级为网页标题动态提示 `(1) 任务标题`，并保留可选的 Web Notification 横幅。
- **无感架构**：
  - Host 端利用 Cordis 会话事件（`turn/end`、`approval/pending`）精准感知状态；
  - 通过轻量 SSE（Server-Sent Events）推送，无轮询性能开销，即使标签页节流也不会遗漏事件。

---

## 📁 目录结构

```
dsh-app-badge/
├── index.js          # Host 端服务：监听会话事件，提供 SSE 事件流与清零 API
├── client.js         # Client 前端脚本：监听焦点状态，操作 Badging API 与网页 Title
├── cordis.patch.yml  # 插件挂载声明
├── package.json      # 插件元信息与 bundle 声明
├── AGENTS.md         # 架构与编码规范约束
└── README.zh.md      # 中文说明文档
```

---

## 🛠️ 安装与配置

### 1. 挂载到 DSH Profile（如 web）

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中添加：

```json
"dsh-app-badge": "link:/Users/jkw/Documents/dshspace/plugins/dsh-app-badge"
```

在 `dsh.profile.bundles` 数组中引入 `"dsh-app-badge"`。

### 2. 生效方式

重启 `dsh web` 服务即可加载。

---

## 🔍 前端调试 API

在浏览器或 Chrome App 控制台（F12 / Console）中，你可以直接调用暴露的全局对象进行测试：

```javascript
// 手动设置角标为 2
window.__dshAppBadge.set(2);

// 清除角标
window.__dshAppBadge.clear();

// 获取当前计数
window.__dshAppBadge.getCount();

// 申请开启桌面横幅通知权限（可选）
window.__dshAppBadge.requestNotificationPermission();
```

---

## 📄 License

MIT © [JackAIStudio](https://github.com/JackAIStudio)
