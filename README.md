# dsh-session-delete

> 为 DeepSeek Harness（DSH）会话管理新增「删除会话」功能：从会话菜单一处即可**完整删除**一个会话——清理其日志目录、投影缓存，并移除工作区中的全部引用。

`dsh-session-delete` 是一个 DSH Cordis 插件，在侧边栏工作区中每个会话的「⋯」菜单里加入 **删除会话** 条目。点击后经二次确认，delete 操作会永久删除该会话在其本地的全部痕迹，而不仅仅是把它从未分组的会话列表中隐藏或移动。

## 特性

- **干净利落的一键删除**：会话菜单新增「删除会话」，沿用框架菜单项组件渲染，与内置项（固定/重命名/分叉/归档）图标与字体对齐。
- **完整删除，不残留**：
  - 删除会话 JSONL 日志目录（`~/.dsh/sessions/<project-key>/<session-id>/`）；
  - 删除投影缓存记录（`~/.dsh/storages/session_projcache/sessions/<session-id>.json`）；
  - 从所有工作区记账槽中解散该会话（移除引用、取消固定、取消归档）。
- **删除后 UI 立即刷新**：删除流程完成后通过官方 `api-session/removed` 事件通知，会话列表无需重启即消失。
- **运行中会话有护栏（双层）**：侧边栏「正在使用」的会话（GUI 当前打开、`retainedBy.mainView` 持有）在客户端直接拒绝删除并提示原因；宿主侧仅当智能体**正在执行任务**（`agent/status == running`）时返回 409。空闲会话（即使宿主仍挂载着）随时可删，不会被误拦。
- **幂等且安全**：目标不存在时静默跳过；`sessionId` 强制按安全路径段校验（拒绝 `/`、`\`、NUL），杜绝路径穿越。日志目录已不存在的孤儿记录（如仅剩投影缓存的会话）按后端 `_no-cwd` 约定处理，不会报错。
- **鉴权复用**：通过共享 `/api` 通道注册自定义路由，沿用会话自身的 Host/Origin + 浏览器鉴权，无需额外暴露端口。

## 工作原理

会话列表是 DSH 客户端的一种**事件投影**（`api-session/added` / `api-session/removed`），而非对磁盘的实时扫描。因此仅仅删除磁盘文件并不会让会话从界面消失。本插件在宿主侧完成“三管齐下”的删除：

1. **记账**：`workspaceRegistry.list()` 找到包含该会话的工作区并 `detachSession`，再幂等执行 `unpinSession` / `unarchiveSession`；
2. **磁盘**：删除 JSONL 日志目录与投影缓存文件（无 `cwd` 的孤儿记录按 `_no-cwd` 处理）；
3. **通知**：`emit("api-session/removed", sessionId)` 驱动客户端投影更新，界面即时移除该会话。

> 防护说明：客户端拒绝删除 GUI 当前打开的会话；宿主侧通过 `agent/status` 事件跟踪**正在执行**的会话并对其实施 409 拦截。静止/空闲的会话不受影响。

删除能力由宿主侧提供的带鉴权路由 `POST /api/session-delete`（body: `{ sessionId }`）承担，客户端菜单项通过浏览器原生 `fetch` 调用它。

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | 支持客户端动态模块加载（`window.__ModuleLoader__`）与 `ctx.connection.fetch.register` 路由扩展的版本 |
| 运行环境 | Node.js（宿主侧 `node:fs/promises` 等仅使用内置模块，无第三方运行时依赖） |

## 安装

> 推荐使用 DSH 的 Bundle 安装能力（`plugin_manager` → `install_bundle`），它会完成依赖落位、补丁合并与启用。下方“手动安装”仅作为没有该入口时的替代。

### 方式一：Bundle 安装（推荐）

1. 将本目录（或发行包解压目录）放置到你的工作区，例如 `<你的工作区>/dsh-session-delete`。
2. 在 Harness 中打开插件管理，选择 **安装 Bundle**，目标指向该目录。
3. 安装完成后在插件列表确认 `session-delete` 条目为启用状态。

安装后即生效：打开任一会话的「⋯」菜单，最下方出现 **删除会话**。

### 方式二：手动放置

1. 将整个包复制到 profile 的 `node_modules/@local/dsh-session-delete`：
   ```text
   <profile>/node_modules/@local/dsh-session-delete/
   ```
2. 确认 profile 的 `cordis.patch.yml`（或等效补丁聚合）中包含：
   ```yaml
   - insert:
       - id: session-delete
         name: '@local/dsh-session-delete'
   ```
3. 重启（或热重载）Harness。

> 提示：包内既是源码也是安装源（`index.js` / `client.js` 即运行时文件），宿主侧改动需重启生效，客户端改动由 HMR 热更。

## 使用

1. 在侧边栏「工作区」区域找到目标会话。
2. 点击会话行尾部的 **「⋯」** 菜单。
3. 选择 **删除会话**。
4. 在确认弹窗中复核要删除的会话（弹窗会显示会话名称），点击确定。

> ⚠️ **不可恢复**：该操作会永久删除会话日志与投影缓存，并移除其在工作区中的引用。删除前无备份，请确认无误后再执行。

### 支持的操作

| 动作 | 结果 |
| --- | --- |
| 菜单项展示 | 会话「⋯」菜单新增「删除会话」，位于菜单尾部 |
| 点击删除 | 弹出确认框，强调操作不可恢复 |
| 确认后 | 注销工作区引用 → 删除日志与投影缓存 → 触发列表即时刷新 |

## 目录结构

```text
dsh-session-delete/
├── index.js           # 宿主侧：注册 POST /api/session-delete 路由与删除逻辑
├── client.js          # 客户端侧：菜单项组件（框架组件渲染、确认框、fetch 调用）
├── cordis.patch.yml   # Loader 补丁：插入 session-delete 条目
├── package.json       # 包清单：导出、files、dsh.client 注入声明
├── LICENSE            # MIT 许可证
├── locale/
│   ├── zh.json        # 中文文案（并内联镜像于 client.js）
│   └── en.json        # 英文文案
└── icon.svg           # 插件展示图标
```

## 数据与路径说明

删除涉及的实际路径（随 `$DSH_HOME` 变化，缺省为 `~/.dsh`）：

| 内容 | 路径 |
| --- | --- |
| 会话日志目录 | `$DSH_HOME/sessions/<project-key>/<session-id>/` |
| 投影缓存 | `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` |
| 工作区引用 | 由 `workspaceRegistry` 记账（`workspace.json` 等） |

- `project-key` 由会话项目目录（header `cwd`）编码生成；
- 路径段编码对任意字符串做 `~XXXX` 转义，保证跨平台、无路径穿越风险。

## 开发与调试

- **宿主逻辑**：`index.js` 无第三方依赖，仅用 Node 内置模块，便于独立审阅与单测。
- **客户端**：`client.js` 优先尝试运行时解析 `@deepseek-ai/dsh-client-ui-primitives`，仅在可用时复用框架菜单项组件与图标（`MenuItemButton` / `IconTrashOutline16`），全部以 `typeof === "function"` 严格判空，任何解析失败都会安全回退，绝不导致条目失效。
- **验证槽位**：安装后可通过 Cordis Inspect 的 `Slots.listSubTree` 观察 `sidebar.workspaces.session.menu.item` 下 `session-delete` 条目的 `active` 状态。

## 贡献

欢迎提交 Issue 与 Pull Request。请保持：

- 宿主侧零第三方依赖；
- 文案经由 `locale/*.json` 与 `client.js` 内联字典保持一致；
- 删除流程保持幂等、路径安全。

## 许可证

[MIT](LICENSE) © 2026 dsh-session-delete contributors
