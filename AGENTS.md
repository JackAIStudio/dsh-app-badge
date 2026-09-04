# dsh-app-badge

DeepSeek Harness 应用角标（Dock / Taskbar Badge）与后台事件提醒插件。

## 定位与平台适配
- 为已安装的 Chrome PWA（Chrome App）、桌面端封装（JackDSH）以及标准浏览器标签页提供系统级未读与任务完成角标呈现。
- 在已安装的 PWA / Electron 下调用 W3C 标准的 `navigator.setAppBadge` / `navigator.clearAppBadge`，在 macOS Dock 或 Windows 任务栏显示系统级未读计数小红点。
- 在普通浏览器标签页环境下，优雅降级为网页标题未读提示 `(N) Title` 以及可选桌面通知。
- 遵循跨平台设计：不对特定操作系统做假设，支持 macOS、Windows、Linux；在无头 Linux 服务器中静默降级，不发生任何异常。

## 架构职责
- `index.js` (Host)：监听会话生命周期事件（`turn/end` 完成、长任务结束），通过轻量 SSE (`/dsh-app-badge/events`) 和状态接口向前端广播。
- `client.js` (Client)：注入前端运行时，监听窗口激活状态（`visibilitychange`、`focus`），实时操控 Badging API 并与 Host 端同步清零。
