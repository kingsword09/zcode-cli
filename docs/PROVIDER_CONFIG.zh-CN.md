# Provider 配置字段参考

[English](PROVIDER_CONFIG.md) | 简体中文

ZCode 桌面端与 CLI 共用 `~/.zcode/v2/provider_config.json`，文件名使用下划线。
可通过 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指定其他文件。终端显示、工具和网络等
CLI 设置放在 `~/.zcode/cli/setting.json`。

[`provider.example.json`](../provider.example.json) 展示当前个人 provider schema 的配置项。
它是可以解析的标准 JSON，不包含注释；各字段的含义、可选值及互斥关系由本文说明。
本文的“智能配置”对应英文界面的 **Smart configuration**。

## 使用示例文件

示例包含三种用途不同的模型：

| 模型 | 用途 |
| --- | --- |
| `your-model-id` | 已启用；模型能力和请求参数映射自动继承上游目录 |
| `overrides-reference` | 已禁用；展示智能配置可以显式覆盖的全部字段 |
| `manual-reference` | 已禁用；展示完整的手动配置字段 |

另一个已禁用的 provider `coding-plan-example` 用于演示模板继承、Coding Plan API Key
类型和内置图标。它不是账号登录示例。

配置实际 provider 时：

1. 选择稳定的 `providerId`，例如 `local`。`providerName` 是显示名称，修改名称不会
   修改 ID；旧 CLI 配置中 provider 对象的 JSON key 就是 ID。
2. 填写 API Key、API 类型和地址。示例中的 **API Key 为空**。
3. 将模型列表、模型规则、模型顺序和默认选择中的 `your-model-id` 一起替换。
   模型 ID 区分大小写，可以包含 `/`。
4. 删除不需要的禁用示例 provider、模型及其排序项。只复制实际需要的覆盖字段。
5. 已有文件应合并修改，保留其他 provider 和规则。保存后使用 `/model` 刷新目录并选择模型。

示例中的能力值和 Token 上限不是对你的服务器能力的声明。省略字段表示继承目录；
显式写入 `false` 或数值会固定该项，后续上游更新不会覆盖它。

## 顶层结构

| 路径 | 类型／可选值 | 含义 |
| --- | --- | --- |
| `schemaVersion` | `1` | 当前个人配置格式版本，不是 App 版本或目录 revision |
| `config.providerConfigRules.providerRules` | 数组 | 个人 provider 定义或覆盖项，`providerId` 必须唯一 |
| `config.modelConfigRules.providerModelRules` | 数组 | 智能配置：在目录基础上覆盖部分模型字段 |
| `config.modelConfigRules.manualProviderModelRules` | 数组 | 手动配置：完整填写可手动配置的模型字段 |
| `config.providerOrder` | 可选的 provider ID 数组 | provider 的首选显示顺序 |
| `config.defaultModelSelection` | 可选对象 | 新会话使用的共享默认模型 |

两种模型规则数组即使没有内容，也保留空数组。同一个 `(providerId, modelId)` 不可
同时放在两种数组中。模型规则使用精确 ID，不支持正则表达式。

## Provider 字段

以下路径相对于 `providerRules` 数组中的一个条目。

| 路径 | 类型／可选值 | 含义 |
| --- | --- | --- |
| `providerId` | 非空字符串 | 模型、默认选择和已保存会话使用的稳定引用 |
| `providerName` | 可选字符串或 `null` | 显示名称；省略时使用 provider ID |
| `templateId` | 可选字符串或 `null` | 继承已安装的 provider 模板，示例为 `zai-api` |
| `enabled` | 可选布尔值 | 启用或禁用 provider，保留其配置 |
| `config.group` | 可选的 `"standard-personal"` 或 `null` | 个人 provider 所属分组 |
| `config.logo` | 可选对象或 `null` | 内置显示图标；`null` 清除继承的图标 |
| `config.logo.type` | `"builtin"` | 当前支持的图标类型 |
| `config.logo.key` | 非空字符串 | 内置图标 key，例如 `zai`、`bigmodel` |
| `config.access` | 可选对象或 `null` | API Key 鉴权配置，见下文 |
| `config.api` | 可选对象或 `null` | 接口配置，见下文 |
| `config.personalModelIds` | 可选的非空字符串数组或 `null` | 此 provider 下额外添加的模型 |
| `config.modelOrder` | 可选的非空字符串数组或 `null` | provider 内模型的首选顺序 |
| `config.visibility` | 可选的 `"visible"`、`"hidden"` 或 `null` | 在模型选择中的可见性 |

`templateId` 必须指向已安装上游目录中的模板。目前包括 `zai-api`、`zai-standard-api`、
`bigmodel-api`、`bigmodel-standard-api` 等，具体以对应版本目录为准。
模板已提供的模型 ID 不必再复制到 `personalModelIds`。

### 鉴权

| `config.access` 下的字段 | 类型／可选值 | 含义 |
| --- | --- | --- |
| `type` | `"api-key"` 或 `"zhipu-coding-plan-api-key"` | 普通 API Key，或 Z.AI／BigModel Coding Plan API Key |
| `apiKey` | 可选字符串或 `null` | 实际 Key；为空或缺失时不能完成模型请求鉴权 |
| `apiKeyManagementUrl` | 可选 URL 字符串或 `null` | Key 管理页面地址，不是模型请求地址 |

原生 schema 还有账号鉴权分支：`type: "zhipu-account"`，以及
`accountType: "zai" | "bigmodel"`、`mode: "start-plan" | "individual-coding-plan" |
"team-coding-plan" | "off-peak"`、布尔值 `entitled`。这些字段描述 runtime 管理的
账号状态，不能用来填写普通 API Key 或自行授予订阅权限。
固定的 `account:*` provider **不允许在个人文件中覆盖 `access`**；应使用原生登录和
凭证存储。示例不会伪造账号 provider。

### 接口

| `config.api` 下的字段 | 类型／可选值 | 含义 |
| --- | --- | --- |
| `type` | `"anthropic-messages"`、`"openai-chat-completions"`、`"openai-responses"` | 接口使用的协议 |
| `baseUrl` | 可选字符串或 `null` | API 根地址；最终生效的配置必须是有效 URL |
| `headers` | 可选的字符串值对象或 `null` | 附加 HTTP 请求头，例如 `{"X-Client-Name":"zcode-cli"}` |

这些字段可以继承自模板。独立自定义 provider 最终需要有效的 API 类型、地址和鉴权。
`headers` 是请求头名称到字符串值的映射，不用于填写模型请求体参数。

## 模型字段：智能配置

`providerModelRules` 的每个条目包含 `providerId`、`modelId` 和 `config`。
其中 `config` 是**部分覆盖**：仅写 `{"enabled": true}` 时，所有能力和参数规格都继承上游。

| 模型 `config` 下的路径 | 类型 | 界面字段／含义 |
| --- | --- | --- |
| `enabled` | 布尔值 | 启用或禁用模型 |
| `properties.contextWindow` | 正整数 | 上下文窗口，单位为 Token |
| `properties.inputFormat.supportsText` | 布尔值 | 文本输入；桌面端编辑器要求保留文本 |
| `properties.inputFormat.supportsImage` | 布尔值 | 图片输入 |
| `properties.inputFormat.supportsVideo` | 布尔值 | 视频输入 |
| `properties.inputFormat.supportsAudio` | 布尔值 | 原生 schema 的音频能力，不代表 CLI 已提供音频附件 UI |
| `properties.inputFormat.supportsPdf` | 布尔值 | 直接接收 PDF；注意拼写为 `Pdf` |
| `properties.outputFormat.supportsText` | 布尔值 | 文本输出；当前 schema 唯一的输出类型字段 |
| `properties.supportsToolCall` | 布尔值 | 工具／函数调用 |
| `properties.supportsJsonSchemaOutput` | 布尔值 | 结构化输出：接口支持 JSON Schema 输出约束 |
| `properties.supportsNativeWebSearch` | 布尔值 | 原生联网搜索能力 |
| `properties.supportsMidConversationSystem` | 布尔值 | 对话中系统消息：允许在初始消息之后插入系统消息 |
| `properties.requiresMfjsToolSchema` | 布尔值 | runtime 工具 schema 格式的高级兼容选项，通常应继承上游 |
| `optionSpecs.maxOutputTokens.max` | 正整数 | 最大输出 Token，与上下文窗口不同 |
| `optionSpecs.maxOutputTokens.map` | 非空表达式字符串 | 将输出 Token 数映射到 API 请求参数 |
| `optionSpecs.reasoningLevel.values` | 非空、无重复、无空白值的字符串数组 | 从低到高排列的推理等级，具体名称由模型决定 |
| `optionSpecs.reasoningLevel.map` | 非空表达式字符串 | 将所选推理等级映射到 API 请求参数 |

智能配置中上述字段均可省略。只修改一个嵌套字段时，其余同级字段继续继承。
示例把完整字段放在已禁用的 `overrides-reference` 中，避免默认启用的模型被示例数值固定。

### 多模态与三个能力开关

已有的 `local/glm-5.3-flash` 可以用如下覆盖项声明图片、视频和 PDF：

```json
{
  "providerId": "local",
  "modelId": "glm-5.3-flash",
  "config": {
    "properties": {
      "inputFormat": {
        "supportsImage": true,
        "supportsVideo": true,
        "supportsPdf": true
      },
      "supportsJsonSchemaOutput": false,
      "supportsNativeWebSearch": false,
      "supportsMidConversationSystem": false
    }
  }
}
```

只启用后端实际支持的能力。结构化输出不同于仅在提示中要求返回 JSON；原生联网搜索
不同于另外配置搜索 MCP；对话中系统消息不同于支持一条初始 system prompt。

### Token 上限与参数映射

`properties.contextWindow` 和 `optionSpecs.maxOutputTokens.max` 相互独立。
例如 100 万上下文、128000 最大输出，分别填写这两个路径。仅修改数值上限时保留已有的映射。

`map` 是**包含原生映射表达式的字符串**，不是 JSON 对象、JavaScript 回调，
也不是旧的 `providerOptionsByLevel`。runtime 会校验表达式。
两个映射分别使用变量 `reasoningLevel` 和 `maxOutputTokens`。

| 接口行为示例 | 映射字符串内容 |
| --- | --- |
| Chat Completions 输出参数 | `{"max_tokens": maxOutputTokens}` |
| 要求 `max_completion_tokens` 的接口 | `{"max_completion_tokens": maxOutputTokens}` |
| Responses 输出参数 | `{"max_output_tokens": maxOutputTokens}` |
| 直接使用推理强度参数 | `{"reasoning_effort": reasoningLevel}` |
| 不附加请求参数 | `{}` |

完整示例还展示条件表达式：
`reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}`。
Anthropic 兼容接口可能使用上游目录中的 `thinking`／`output_config` 映射。
不能仅根据 API 类型就认定所有模型使用相同的推理字段或等级。

## 模型字段：手动配置

关闭桌面端的**智能配置**后，使用 `manualProviderModelRules`。条目仍然有
`providerId` 和 `modelId`，但 `config` 使用另一套 schema：

- `enabled` 可选。
- 必须填写 `properties.contextWindow`。
- `properties.inputFormat` 必须包含布尔值 `supportsImage`、`supportsVideo`、`supportsPdf`。
- 必须填写布尔值 `properties.supportsJsonSchemaOutput`、`supportsNativeWebSearch`、
  `supportsMidConversationSystem`。
- `optionSpecs.maxOutputTokens` 必须包含正整数 `max`。
- `optionSpecs.reasoningLevel` 必须同时包含 `values` 和 `map`。

手动条目不能填写 `supportsText`、`supportsAudio`、`outputFormat`、`supportsToolCall`、
`requiresMfjsToolSchema` 或 `maxOutputTokens.map`，它们不属于手动 schema。
协议层字段仍由目录提供；手动模式固定的是上面列出的可编辑字段。
切换配置模式时，应在两种数组之间移动条目，不能把同一模型同时放进两处。

## 默认模型、继承与清除覆盖

`config.defaultModelSelection` 的结构为：

```json
{
  "providerId": "local",
  "modelId": "glm-5.3-flash",
  "options": {
    "reasoningLevel": "high"
  }
}
```

`options` 和 `options.reasoningLevel` 都可省略。显式推理等级必须属于该模型最终生效的
`reasoningLevel.values`；省略 `options` 时由 runtime 使用模型的当前默认值补齐。
`defaultModelSelection.options` 中没有 `maxOutputTokens` 字段。

缺失字段表示继承。要让某项能力重新跟随上游更新，应删除个人覆盖项。
许多 provider 字段和智能模型覆盖字段允许用 `null` 清除值，但 **`null` 不表示自动继承**，
而且可能让最终配置缺少必填项。手动模式的必填字段不能这样清除。
可使用桌面端的恢复操作，或者删除相应覆盖字段。

## 自动同步上游模型

同步 runtime 时会复制完整的上游 `config/provider/zcode-builtin.json`，包括模型匹配规则、
全部能力、Token 上限和请求参数映射。已有的提取目录文件也会更新，不再跳过旧文件。
原生 runtime 同时负责正常的目录刷新和 revision 管理。

registry 将上游目录与个人文件组合。智能配置模型会自动继承更新后的多模态、
工具／联网／系统消息能力、上下文和输出上限、推理等级与映射。显式个人覆盖优先，
手动配置的可编辑字段保持固定。刷新不会把最终能力值写回每个个人模型，否则上游值会
变成永久覆盖，后续就无法自动更新。

模型解析遵循上游的模型、API 和 provider 站点规则。未知自定义接口可能需要手动覆盖；
CLI 不会仅凭模型名字猜测它支持图片或原生搜索。使用 `/model` 刷新实时目录。
目录更新不会更改已保存的模型 ID 或用户明确选择的推理等级。

## 不属于此文件的字段

个人配置不能直接复制为上游目录格式。以下字段不接受写入此处：`revision`、
`templateRules`、`templateNameMap`、`builtinModelIds`、`modelRules`、`modelApiRules`、
`providerSiteRules`、`templateModelRules`、`builtinProviderModelRules`。
`zai-family` 和 `bigmodel-family` 分组也由原生账号配置声明。

旧版的 `provider`、`model.main`、`model.lite`、`models`、`modalities`、`limit`、
`modelCatalog` 结构不是新 schema 的字段。CLI 权限模式、Plan 状态、重试、超时、
通知、存储路径及 MCP／插件设置同样不属于 `provider_config.json`；参见
[配置说明](CONFIGURATION.zh-CN.md)。
