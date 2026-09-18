# 配置说明

[English](CONFIGURATION.md) | 简体中文

CLI 跟随当前 ZCode runtime 的 provider registry schema。通用运行设置与 provider 配置
分别存储；模型配置中的“智能配置”对应英文界面的 **Smart configuration**。

## 配置文件

| 文件 | 用途 |
| --- | --- |
| `~/.zcode/cli/setting.json` | CLI 主题、通知、工具、存储和其他运行设置 |
| `~/.zcode/v2/setting.json` | 桌面端已有的语言和记忆偏好，CLI 只读不修改 |
| `~/.zcode/v2/provider_config.json` | Provider、模型元数据覆盖和默认模型 |
| `~/.zcode/v2/credentials.json` | 原生 runtime 持久化的凭证 |

Windows 使用 `%USERPROFILE%` 代替 `~`。Provider 文件默认与桌面端共用，修改 provider
或已保存的默认模型会影响两个客户端；`/model` 只切换当前 CLI 会话。

设置 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 可使用独立的 provider 文件。
`ZCODE_DATA_BASE_DIR` 改变原生 runtime 的基础目录，包括 provider 和凭证存储。
CLI 通用设置仍使用用户目录中的 `~/.zcode/cli/setting.json`。

首次启动时，CLI 根据不含凭证的 [`setting.example.json`](../setting.example.json)
创建通用设置，不覆盖已有文件。Provider 配置由原生登录创建，或参考
[`provider.example.json`](../provider.example.json) 填写。
[Provider 配置字段参考](PROVIDER_CONFIG.zh-CN.md) 列出了全部个人配置字段、桌面端字段对应关系
及上游目录继承规则。

## 启动迁移

CLI 参考桌面端迁移规则，使用 runtime 的原生解析器和带文件锁的 provider 仓库。
桌面端在首次创建原生文件时导入旧 provider；由于共享文件可能已经存在，CLI 启动时会额外
执行一次从 `~/.zcode/cli/config.json` 到共享文件的合并。

只添加缺失的个人 provider ID，保留已有 provider 定义、模型覆盖、排序和共享默认选择。
账号 provider 和加密密钥不参与导入；已删除的模型也不导入。模型 ID 与 provider 别名
由上游解析器规范化，不支持的 provider 配置会记为跳过。

CLI 专属字段迁移到 `~/.zcode/cli/setting.json`，省略 provider、main/lite 和目录覆盖字段。
旧文件保留原样。`~/.zcode/cli/migrations/` 中按目标 provider 文件记录完成标记，防止后续
启动恢复用户已删除的 provider。独立的 `settings-v1.json` 标记防止重置新设置文件后
再次导入旧设置。

旧文件不作为运行时配置 fallback。新文件无效时会报告错误，不会用旧设置替换它。

## 设置归属与优先级

| 设置或操作 | 读写行为 |
| --- | --- |
| Provider 和模型元数据 | 共享的原生 `provider_config.json` |
| `/settings` 中的默认模型 | 写入共享默认选择，并应用到当前会话 |
| `/model`、模型循环切换、推理强度 | 修改并保存当前会话选择，不改共享默认值 |
| `/new` | 读取当前共享默认模型 |
| 恢复会话／重启 | 恢复该会话保存的模型和推理选项 |
| 语言与记忆 | 读取桌面端 `localePreference`／`memoryEnabled`，显式 CLI 设置优先 |
| 主题、终端布局、选中复制、通知 | CLI `setting.json` |
| 工具权限、重试、流超时、CLI 插件／MCP 等运行设置 | CLI `setting.json`，保留原生项目和环境配置优先级 |
| 更新缓存、诊断日志、迁移状态 | CLI 目录下的运行文件 |

CLI 不向桌面端的 `setting.json` 增加字段。通知和显示设置只写 CLI 文件。
共享偏好在加载 runtime 设置时生效，不会因修改其他 CLI 选项而被复制进 CLI 设置。

## 模型目录与默认选择

原生 registry 加载随包提供的目录，并管理上游目录刷新。`/model`、模型循环切换以及
**设置 > Model providers** 会从配置源刷新当前 registry，保留当前会话。
CLI 不再维护独立的旧版模型目录缓存。

Provider 文件中的 `config.defaultModelSelection` 决定新会话使用的模型。
`/settings` 通过原生仓库保存该选择并应用到当前会话；`/model provider/model` 只切换
当前会话。恢复的会话可以继续使用它自己保存的选择。

保存的选择未指定推理选项时，runtime 使用该模型的目录默认值补齐。
已经明确选择的推理强度会保留。

## 首次设置

第一次交互启动会显示设置向导，可选择 **Sign in**、**Custom provider** 或 **Skip for now**。
使用 `/setup` 可以重新打开。通用配置旁的 `setup-pending` 标记在非交互命令后仍会保留，
成功配置或明确跳过后才会清除。已有原生 provider 配置会被直接识别，无需单独导入桌面端配置。

## 模型访问

- **macOS 上的 Z.AI OAuth：** 使用 `zcode login`；`zcode login --oauth` 强制重新授权。
  `--no-browser` 只输出授权链接。
- **Z.AI／BigModel Coding Plan API Key：** 打开 `/login`，选择掩码输入的 API Key 选项。
  凭证和 provider 的保存由官方 runtime 负责。
- **自定义 provider：** 直接配置原生 provider 文件，可使用自定义 ID，无需额外 OAuth 登录。

普通的 `zcode login` 会识别已经配置的原生默认模型并提示配置路径。
本地仅检查配置是否存在，凭证校验与解密由 runtime 负责。

macOS OAuth 会临时注册回调接收器、校验 `state`，恢复原来的 `zcode://` 处理程序，并通过
stdin 把回调交给 runtime。Runtime 交换令牌、保存加密凭证、解析 Coding Plan API Key，
再保存原生默认模型；TUI 随后重新读取 provider 配置。BigModel 使用 runtime 的 localhost 回调。

## 自定义 Provider

`provider.example.json` 中启用的模型自动继承上游目录，禁用的参考模型分别展示智能覆盖和
手动配置的全部字段。填写空 API Key、替换占位 ID 和地址，并删除不需要的参考条目。
已有文件应合并修改，保留其他规则和选择。

最小配置结构如下：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "custom",
          "providerName": "Custom provider",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "YOUR_API_KEY" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "https://api.example.com/v1"
            },
            "personalModelIds": ["your-model-id"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "custom",
      "modelId": "your-model-id"
    }
  }
}
```

Anthropic 兼容接口使用 `anthropic-messages`，Chat Completions 使用
`openai-chat-completions`，Responses API 使用 `openai-responses`。
`baseUrl` 是 API 根地址；模型 ID 区分大小写，引用格式为 `providerId/modelId`。

```text
/model custom/your-model-id
/settings
/new
```

原生目录提供已知模型的上下文、推理选项及输入输出能力。自定义覆盖写在
`modelConfigRules` 下，包括 `properties.contextWindow`、`properties.inputFormat`
和 `optionSpecs`。图片、视频及 PDF 支持以所选模型的 registry 元数据为准。

桌面端三个能力开关分别对应 `properties.supportsJsonSchemaOutput`、
`supportsNativeWebSearch`、`supportsMidConversationSystem`。最大输出 Token 是
`optionSpecs.maxOutputTokens.max`，与上下文容量不同；请求参数映射写在对应选项的
`map` 字符串中。完整说明见 [Provider 字段参考](PROVIDER_CONFIG.zh-CN.md)。

上游目录更新后，智能配置模型会自动继承新的能力与参数规格；只有显式个人覆盖保持固定。
同步 runtime 会复制完整目录，`/model` 会刷新实时 registry，不必把上游能力值逐个写进个人文件。

## 权限模式与计划状态

CLI 与桌面端一样提供三种权限模式：`build`（变更前确认）、`edit`（自动编辑）、
`yolo`（完全访问）。`/mode` 打开选择器，Shift+Tab 在三种模式间循环。
底层的 `auto` 值不作为菜单选项。

`/plan` 独立切换计划开关，也可以用 `/plan on`、`/plan off` 明确指定状态。
切换权限不会改变 Plan 开关，切换 Plan 也不会改变权限。验证由原生 runtime 负责，
包括 Plan 与进行中的 Goal 不可同时开启的限制。

Plan 开启时，在输入框上边框右端显示 `Plan`，不增加行数；空编辑器会显示规划提示。
状态栏始终显示权限模式，`/status` 分别列出 Mode 和 Plan。
标签跟随原生状态变化，包括批准计划、新会话及恢复会话，不额外写入 CLI Plan 偏好。

## 发送前的访问检查

新的无界面提示和普通 TUI 输入会在开始模型请求前，检查明显缺少 provider 配置或
显式缺少 API Key 的情况。检查不会输出密钥、凭证，也不会通过网络验证它们。
账号鉴权、格式错误的配置、环境覆盖、项目配置以及恢复的无界面会话，仍由 runtime 处理。

TUI 会把被拒绝的输入放回空编辑器，或保留在后续输入队列中，不覆盖新草稿。
无界面命令会退出并输出配置说明。登录、设置和其他管理命令仍可使用。

### 后台 Agent

运行超过一秒的 Agent 调用默认转入后台，通过 `/tasks` 继续访问；短任务保留在当前轮次，
便于直接使用结果。阈值单位为毫秒：

```json
{
  "subagents": {
    "autoBackgroundMs": 1000
  }
}
```

设为 `0` 可禁用自动后台化。工具调用中显式设置 `run_in_background: true` 时会立即进入后台。

### 请求重试和流中断

重试分类和执行由官方 runtime 负责。CLI 提供默认五次重试预算，可使用原生环境变量覆盖：

```bash
ZCODE_MODEL_RETRY_MAX_RETRIES=3 zcode
```

新建配置使用 60 秒的模型流空闲超时：

```json
{
  "modelStream": {
    "idleTimeoutMs": 60000
  }
}
```

已有配置不会被覆盖；如果旧文件仍为 `600000`，需要手动修改。可重试的超时、断流、
限流、服务端和网络错误会重试并在 TUI 中显示。鉴权失败和无效请求不重试。

## Runtime 诊断日志

交互 TUI 会捕获 runtime 的 `stderr`，防止后台日志破坏终端显示。Runtime 非零退出时，
TUI 结束后会输出退出状态和日志路径。日志限制为 2 MB，下次启动时轮转为 `.1`，
两个文件均使用仅当前用户可读写的权限。

默认路径为 `~/.zcode/cli/tui-runtime.log`，也可指定独立路径：

```bash
ZCODE_TUI_RUNTIME_LOG=/tmp/zcode-tui-runtime.log zcode
```

## TUI 显示模式

默认使用普通终端回滚模式。将 `ui.tuiMode` 设为 `"fullscreen"` 可使用替代屏幕、
独立滚动的会话记录、固定输入区和鼠标滚轮／滚动条导航。浏览旧消息时输入区仍然可用。
内容放得下时隐藏滚动条；滚动时短暂显示，并跟随明暗主题。

```json
{
  "ui": {
    "tuiMode": "fullscreen"
  }
}
```

也可以在 `/settings` 或 `/config` 的 **Display mode** 中修改。
`ZCODE_TUI_MODE=fullscreen` 和 `ZCODE_TUI_MODE=regular` 临时覆盖保存值，设置页会提示该覆盖，
不会删除环境变量。

正常退出或处理 `SIGINT`、`SIGTERM`、`SIGHUP` 时会恢复终端状态。
任何终端程序都无法拦截强制的 `SIGKILL`。

### 选中自动复制

全屏模式中，释放鼠标选择会把文本复制到系统剪贴板。将 `ui.copyOnSelect` 设为 `false`
可只高亮、不自动复制；终端原生选择仍可通过按住 Shift 或终端指定的修饰键使用。
此选项只影响全屏模式，普通回滚模式不启用鼠标选择。
设置页中的 **Fullscreen copy on select** 提供同一开关。

```json
{
  "ui": {
    "copyOnSelect": false
  }
}
```

## 主题

在 CLI `setting.json` 中将 `ui.theme` 设为 `"auto"`、`"dark"` 或 `"light"`。
macOS／Linux 路径为 `~/.zcode/cli/setting.json`，Windows 为
`%USERPROFILE%\.zcode\cli\setting.json`。明确指定的明暗主题优先于终端探测。
`auto` 在启动时查询终端背景和配色模式，并应用匹配的调色板。

## 轮次完成通知

默认在终端失去焦点时，为普通 Agent 轮次的完成或失败发送通知。
自动选择终端能力的策略与 Codex 一致：`auto` 在 Ghostty、iTerm2、Kitty、Warp 和 WezTerm
中使用 OSC 9，在 Apple Terminal 等终端中使用 BEL。显式选择 OSC 9 而终端不支持时也改用 BEL，
避免发送被忽略的序列。

`unfocused` 条件使用终端的 DEC 焦点报告。在尚未确认焦点支持时，会发送通知，
不会一直当作“已聚焦”而抑制通知。`native` 需要明确启用，并使用已有系统工具：
macOS 的 `terminal-notifier`、Linux 的 `notify-send` 或 Windows 的 `SnoreToast`。
项目不捆绑这些工具；命令不可用或发送失败时使用 BEL。

macOS 会将检测到的终端 App 用作发送者和点击目标。能否恢复精确的标签页或窗格取决于终端；
默认 `auto` 可以保留支持 OSC 的终端原生行为。

在 TUI 中打开设置：

```text
/config
/settings
```

两个命令等效。保存一项后返回设置首页，便于连续修改；Esc 先返回首页，再关闭设置。
修改立即应用到当前会话，并持久化到 CLI `setting.json` 的 `ui.notifications`：

```json
{
  "ui": {
    "notifications": {
      "method": "auto",
      "condition": "unfocused"
    }
  }
}
```

环境变量在启动时覆盖文件值，适合当前 shell 的临时设置：

```bash
export ZCODE_TUI_NOTIFICATION_METHOD=auto       # auto|osc9|bel|native|off
export ZCODE_TUI_NOTIFICATION_CONDITION=always  # unfocused|always
zcode
```

## 官方 MCP 可用性

如果捆绑 runtime 没有官方 MCP 的可信来源 registry，官方 HTTP MCP 服务会显示为禁用，
诊断码为 `official_auth_unavailable`。插件的其他组件仍然可用。
这不会关闭证书、来源或权限校验；runtime 提供所需 registry 时也不会抑制服务。
该处理不会改写用户配置。
