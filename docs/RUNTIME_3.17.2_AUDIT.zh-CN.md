# Desktop 3.17.2 / runtime 0.17.1 升级核查

核查日期：2026-11-03。结论：现有同步、启动器和 TUI 适配可以直接使用
Desktop 3.17.2 的 runtime；没有发现需要新增兼容补丁的阻断问题。

## 核查来源

- [官网更新日志](https://zcode.z.ai/cn/changelog)：3.17.2 发布于 2026-11-03。
- [稳定渠道 manifest](https://zcode.z.ai/api/v1/releases/electron/manifest?platform=linux-x86_64&channel=1)：
  Linux x64 的 3.17.2 安装包地址和 SHA-512；同步时已校验下载文件。
- [GitHub 源码比较](https://github.com/zai-org/ZCode/compare/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1...a9fe401eede6e6e5e01be9048679c206fe6f02d9)：
  基线为 `v3.17.1`，新快照为 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`
  （`chore: sync ZCode source v3.17.2`），共 203 个文件变化。

核查时 GitHub 最新 release/tag 仍是 `v3.17.1`；`main` 已发布 3.17.2 源码。
公开源码快照与下载产物分别核查，不据此断言产物由该提交精确构建。
完整安装包校验值以 `zcode-runtime.lock.json` 为准。

官网日志从 3.16.3 直接列到 3.17.2，因此不能把整份日志都当成相对本项目
3.17.1 的新增变化。例如 Sites 插件及 Kimi / MiniMax 模型配置已经存在于
`v3.17.1` 源码；本次源码比较中内置 provider 配置没有变化。

## 对本 CLI 有影响的变化

| 范围 | 3.17.1 → 3.17.2 源码变化 | 本项目处理 |
| --- | --- | --- |
| 自定义命令 | 不再在命令展开阶段执行行内 `!` 和 fenced shell 块；改写为模型通过 Bash 工具执行的指令，经过工具权限控制；无法解析的插件/技能变量不执行 | 保留上游实现，新增直接 runtime 与 launcher `-p` 两条路径的回归，验证无文件副作用且改写文本到达模型 |
| Plan 权限 | Plan 作为基础模式之上的收紧闸门，不再免除需审批的只读工具；build/edit 下非只读、非 destructive MCP 调用需询问，不提供始终允许；guarded 危险操作仍需单次确认 | 没有绕过或替换该权限实现；现有 guarded 原生终端回归通过 |
| 子代理 | Explore 使用父会话权限服务；插件 agent 的权限声明只能收紧父模式；子会话保留工作区身份 | 保留上游实现；现有子代理桥接补丁仍兼容，不添加放宽权限的补丁 |
| 会话生命周期 | 激活/重启可携带 workspace，并验证绑定；冷恢复及并发启动避免会话串属；关闭资源按名称收集错误并处理同步重入 | 现有会话恢复、重命名、失败保存及 headless 关闭回归通过 |
| 草稿提权 | 未持久化草稿不提前写入授权子记录；授权发布失败可复用事件，避免重复提权 | 保留上游实现，不改变本项目权限确认流程 |
| MCP 诊断 | 启动失败携带有界 stderr 诊断；清理终端控制字符并加强凭证脱敏 | 保留上游实现，不将诊断文本重新分类为可重试错误 |

相关源码位于 `apps/zcode-cli/packages/` 的 `contracts/src/commands/index.ts`、
`core/src/permission/service.ts`、`core/src/runtime/methods/subagent.ts`、
`core/src/runtime/permission-full-access.ts`、`bootstrap/src/session-lifecycle/`、
`bootstrap/src/app/session-facade.ts` 和 `adapters/src/mcp/index.ts`。

官网还列出内容安全拦截快速失败、无进展循环结束、配额恢复后继续工作流、
配置损坏保护等变化。这些属于官网跨版本汇总；本次 CLI 保留产物中的实现，
不能仅由该日志推断它们都是相对 3.17.1 的新改动。

## 不应误认为 CLI 已新增的界面功能

图片标注、未读筛选、项目批量管理、远程设备菜单、预览卡片、Finder 定位、
MCP 设置页及插件一键全部更新主要属于 Desktop 界面。本项目的 TUI 不会因为
替换 runtime 自动获得这些按钮或界面，不需要为了保持兼容照搬 Desktop UI。

`zcode-site-plugin` 0.4.2 随产物保留，命令、技能、MCP server 和第三方声明均在
`vendor/packages/zcode-site-plugin/`。TUI 不提供 Desktop 的 Sites 面板。
该插件声明 Node >=24；本次 Node 22.19.0 和 26.4.0 的离线 MCP initialize
均成功，但这不构成 Node 22 上所有部署功能受支持的保证。需要使用 Sites 时
建议 Node >=24。没有执行实际部署、消耗额度或调用真实账号服务。

## 升级与验证

- `bun run sync` 完成 Linux x64 安装包 SHA-512 校验、提取和启动验证。
- npm 版本更新为 `3.17.2-43`，保留原 CLI build 号；底层 `--version` 仍为
  `0.17.1`，不是同步失败。
- 36 项 runtime 补丁全部通过应用、幂等及后置校验；无失败、无可选补丁跳过。
  补丁状态和全局 CLI capability 与 3.17.1 提取记录一致。
- 保留 SQLite recovery、网络重试/EOF、OAuth、Start Plan 和 headless 补丁；
  不能因官网泛称修复便删除针对本 CLI 的补丁。
- Node 26.4.0：全套原有 158 项测试通过，另新增 2 项命令 shell 回归通过。
- Node 22.19.0：54 项原生 runtime 测试、17 项真实 Node 持久化测试及 runtime
  检查通过。两组 Node 验证均在本机 macOS arm64 上执行。
- `bun run typecheck`、`bun run check`、`bun run check:tui`、package tree 检查及
  `bun run release:pack` 的安装后 smoke test 通过。

上述测试使用临时 HOME、临时数据库和本地 HTTP fixture，不修改真实用户配置，
也不验证真实 OAuth、模型服务、远程设备或站点部署。完整结果并非对所有生产
场景或所有平台的承诺；Linux/Windows 仍应由仓库 CI 验证。

## 发布边界

`vendor/` 是生成且被 Git 忽略的产物；提交 lock、版本和测试后，CI 使用
`bun run sync:locked` 重建相同安装包并应用同一补丁计划。本次没有发布 npm、
没有提交 Git，也没有自动递增 CLI build 号。
上游 notice 的原始固定 revision 保持不变，文档已更新当前产物版本；
插件自带 license 和第三方声明继续保留，固定源码声明不是完整产物 SBOM。
