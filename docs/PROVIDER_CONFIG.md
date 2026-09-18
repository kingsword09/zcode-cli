# Provider configuration reference

English | [简体中文](PROVIDER_CONFIG.zh-CN.md)

ZCode Desktop and CLI share `~/.zcode/v2/provider_config.json` (underscore).
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` can select another file. General terminal,
tool and network settings belong in `~/.zcode/cli/setting.json`.

[`provider.example.json`](../provider.example.json) covers the current personal
provider schema. It is valid JSON without comments. This reference explains the
fields, alternatives and restrictions that cannot be expressed as JSON comments.

## Using the example

The example deliberately contains three different model configurations:

| Model | Purpose |
| --- | --- |
| `your-model-id` | Enabled; inherits model capabilities and request mappings from the upstream catalog |
| `overrides-reference` | Disabled; demonstrates every field available in an smart-configuration override |
| `manual-reference` | Disabled; demonstrates the complete manual-configuration schema |

The disabled `coding-plan-example` provider demonstrates template inheritance,
the Coding Plan API-key type and a built-in logo. It is separate from account login.

To configure a real provider:

1. Choose a stable `providerId`, such as `local`. `providerName` is its display name;
   changing that name does not change the ID. The legacy CLI JSON key was the ID.
2. Fill in the API key, API type and base URL. The example has an **empty API key**.
3. Replace `your-model-id` in the provider membership, model rule, model order and
   default selection. Model IDs are case-sensitive and may contain `/`.
4. Remove the disabled reference models/provider and their ordering entries unless
   you need them. Copy only the specific overrides your endpoint requires.
5. Merge into an existing file rather than replacing other providers and rules.
   Run `/model` to refresh the registry, then choose the model.

The reference capability values and token limits describe an example, not the
capabilities of your server. Leaving a field absent lets the catalog supply it;
copying an explicit `false` or limit pins that field to your chosen value.

## Top-level structure

| Path | Type / values | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Current personal configuration format; not the App or catalog revision |
| `config.providerConfigRules.providerRules` | Array | Personal provider definitions and overrides, each with a unique `providerId` |
| `config.modelConfigRules.providerModelRules` | Array | Smart model configuration: partial overrides applied over the catalog |
| `config.modelConfigRules.manualProviderModelRules` | Array | Manual model configuration: the full editable model configuration |
| `config.providerOrder` | Optional array of provider IDs | Preferred provider display order |
| `config.defaultModelSelection` | Optional object | Shared default selection for new sessions |

Both model-rule arrays are present even when empty. A given `(providerId, modelId)`
must not appear in both arrays. A rule uses exact IDs, not a regular expression.

## Provider fields

Paths in this section are relative to an entry in `providerRules`.

| Path | Type / values | Meaning |
| --- | --- | --- |
| `providerId` | Nonempty string | Stable reference used by models, defaults and saved sessions |
| `providerName` | Optional string or `null` | Display name; omitted names use the provider ID |
| `templateId` | Optional string or `null` | Inherit an installed provider template; the example uses `zai-api` |
| `enabled` | Optional boolean | Enable/disable the provider without deleting its configuration |
| `config.group` | `"standard-personal"` or `null`, optional | The editable personal-provider group |
| `config.logo` | Optional object or `null` | Built-in display logo; `null` clears an inherited logo |
| `config.logo.type` | `"builtin"` | Current supported logo representation |
| `config.logo.key` | Nonempty string | Built-in logo key, such as `zai` or `bigmodel` |
| `config.access` | Optional object or `null` | API-key authentication configuration; see below |
| `config.api` | Optional object or `null` | Endpoint configuration; see below |
| `config.personalModelIds` | Optional array of nonempty strings or `null` | Additional models belonging to this provider |
| `config.modelOrder` | Optional array of nonempty strings or `null` | Preferred model order within the provider |
| `config.visibility` | `"visible"`, `"hidden"`, or `null`, optional | Provider visibility in model selection |

`templateId` must refer to a template in the installed upstream catalog. Current
examples include `zai-api`, `zai-standard-api`, `bigmodel-api` and
`bigmodel-standard-api`; template availability follows the upstream release.
Template-supplied model IDs do not need to be copied into `personalModelIds`.

### Authentication

| Path under `config.access` | Type / values | Meaning |
| --- | --- | --- |
| `type` | `"api-key"` or `"zhipu-coding-plan-api-key"` | Direct API key or Z.AI/BigModel Coding Plan API key |
| `apiKey` | Optional string or `null` | Actual key; an empty/missing key does not authenticate a model request |
| `apiKeyManagementUrl` | Optional URL string or `null` | Link to the provider's key-management page; not a model endpoint |

The native schema also has an account-access branch with `type: "zhipu-account"`,
`accountType: "zai" | "bigmodel"`, `mode: "start-plan" |
"individual-coding-plan" | "team-coding-plan" | "off-peak"`, and an `entitled`
boolean. These describe runtime-managed account access. They are not a way to
configure an API key or grant a subscription. For fixed `account:*` providers,
the personal file **rejects an `access` override**. Use native login and its
credential store; the example does not manufacture an account provider.

### Endpoint

| Path under `config.api` | Type / values | Meaning |
| --- | --- | --- |
| `type` | `"anthropic-messages"`, `"openai-chat-completions"`, `"openai-responses"` | Wire protocol understood by the endpoint |
| `baseUrl` | Optional string or `null` | API root; the effective configuration must resolve to a valid URL |
| `headers` | Optional object of string values or `null` | Additional HTTP headers, e.g. `{"X-Client-Name":"zcode-cli"}` |

Fields can be inherited from a template. A standalone custom provider needs an
effective API type, base URL and usable authentication. `headers` is a map of
header names to strings; it is not a place for model request-body parameters.

## Model fields: smart configuration

Each entry in `providerModelRules` has `providerId`, `modelId` and `config`.
Its `config` is a **partial overlay**. An entry containing only
`{"enabled": true}` inherits all capability fields and option specifications.

| Path under model `config` | Type | Desktop field / meaning |
| --- | --- | --- |
| `enabled` | Boolean | Include/exclude this model |
| `properties.contextWindow` | Positive integer | Context window: total context capacity in tokens |
| `properties.inputFormat.supportsText` | Boolean | Text input; text is required by Desktop's model editor |
| `properties.inputFormat.supportsImage` | Boolean | Image input |
| `properties.inputFormat.supportsVideo` | Boolean | Video input |
| `properties.inputFormat.supportsAudio` | Boolean | Audio capability in the native schema; not a promise of a CLI audio attachment UI |
| `properties.inputFormat.supportsPdf` | Boolean | Direct PDF input; note the spelling `Pdf` |
| `properties.outputFormat.supportsText` | Boolean | Text output; this is the current schema's only output-format field |
| `properties.supportsToolCall` | Boolean | Tool/function calling |
| `properties.supportsJsonSchemaOutput` | Boolean | Structured output: API-supported JSON Schema output |
| `properties.supportsNativeWebSearch` | Boolean | Native web search: runtime/provider-native search capability |
| `properties.supportsMidConversationSystem` | Boolean | Mid-conversation system messages: system messages inserted after the initial message |
| `properties.requiresMfjsToolSchema` | Boolean | Advanced compatibility flag for the runtime's tool-schema format; normally inherit it |
| `optionSpecs.maxOutputTokens.max` | Positive integer | Max output tokens: output limit, separate from the context window |
| `optionSpecs.maxOutputTokens.map` | Nonempty expression string | Maps the output-token value into API request parameters |
| `optionSpecs.reasoningLevel.values` | Nonempty array of unique nonblank strings | Reasoning levels, ordered from lower to higher; available labels depend on the model |
| `optionSpecs.reasoningLevel.map` | Nonempty expression string | Reasoning parameter mapping: maps the selected reasoning level into API request parameters |

All these fields are optional in an smart override. Changing one nested
field leaves its siblings inherited. The full example lists every field in the
disabled `overrides-reference` model so it does not silently pin the enabled
model's capabilities.

### Multimodal capabilities and the three capability switches

For an existing `local/glm-5.3-flash` entry, an image/video/PDF override can be:

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

Only enable capabilities your endpoint actually supports. JSON Schema output
is more than asking the model to write JSON. Native search is distinct from
configuring a search MCP server. Mid-conversation system-message support is
distinct from accepting an initial system prompt.

### Token limits and request mappings

`properties.contextWindow` and `optionSpecs.maxOutputTokens.max` are independent.
For example, a 1,000,000-token context and a 128,000-token output limit use those
two different paths. Preserve an existing mapping when changing only a limit.

Mappings are **strings containing the native mapping expression**, not JSON
objects, JavaScript callbacks or the old `providerOptionsByLevel` structure.
The runtime validates the expression. The two variables are `reasoningLevel`
and `maxOutputTokens`, each in its corresponding map.

| Example endpoint behavior | Mapping string |
| --- | --- |
| Chat Completions output parameter | `{"max_tokens": maxOutputTokens}` |
| An endpoint requiring `max_completion_tokens` | `{"max_completion_tokens": maxOutputTokens}` |
| Responses output parameter | `{"max_output_tokens": maxOutputTokens}` |
| Direct reasoning-effort parameter | `{"reasoning_effort": reasoningLevel}` |
| No extra request parameters | `{}` |

The complete example additionally demonstrates a conditional reasoning map:
`reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}`.
An Anthropic-compatible endpoint may need a different map, such as the upstream
catalog's `thinking` / `output_config` parameters. API type alone does not imply
that every model supports the same reasoning fields or levels.

## Model fields: manual configuration

Turning off Desktop's **Smart configuration** uses `manualProviderModelRules`. A manual entry
has the same `providerId` and `modelId` identity, but a different `config` schema:

- `enabled` is optional.
- `properties.contextWindow` is required.
- `properties.inputFormat` must contain `supportsImage`, `supportsVideo` and
  `supportsPdf`, each a boolean.
- `properties.supportsJsonSchemaOutput`, `supportsNativeWebSearch` and
  `supportsMidConversationSystem` are required booleans.
- `optionSpecs.maxOutputTokens` must contain the positive integer `max`.
- `optionSpecs.reasoningLevel` must contain both `values` and `map`.

Do not put `supportsText`, `supportsAudio`, `outputFormat`, `supportsToolCall`,
`requiresMfjsToolSchema` or `maxOutputTokens.map` in a manual entry: they are not
fields of that schema. Protocol-level fields still come from the catalog;
manual mode fixes the editable fields listed above. Move the entry between the
arrays when changing mode; never duplicate its identity across both arrays.

## Defaults, inheritance and clearing overrides

`config.defaultModelSelection` accepts exactly:

```json
{
  "providerId": "local",
  "modelId": "glm-5.3-flash",
  "options": {
    "reasoningLevel": "high"
  }
}
```

`options` and `options.reasoningLevel` are optional. An explicit level must belong
to that model's effective `reasoningLevel.values`. Omit `options` to let the
runtime complete the selection from the model's current defaults. There is no
`maxOutputTokens` field inside `defaultModelSelection.options`.

Missing fields inherit. To resume automatic upstream updates for a capability,
delete its personal override. Many provider fields and smart model-overlay
fields accept `null` to clear a value; `null` is **not** a synonym for inheritance
and can make the effective model incomplete. Manual required fields cannot be
cleared this way. Use Desktop's restore action, or remove the relevant override.

## Automatic upstream model updates

Runtime synchronization copies the entire current upstream
`config/provider/zcode-builtin.json`, including model matching rules, all
capabilities, token limits and request mappings. An existing extracted file is
replaced with the current source catalog; it does not pin the previous revision.
The native runtime also owns its normal catalog refresh and revision handling.

The registry combines the upstream catalog with this personal file. Smart
models automatically inherit updated multimodal flags, tool/search/system-message
capabilities, context/output limits, reasoning levels and mappings. Explicit
personal overrides win. Manual editable values remain fixed. Refreshing does
not copy effective values into the personal file, because that would turn every
upstream value into a permanent user override.

Model resolution depends on the upstream model, API and provider-site rules.
An unknown custom endpoint can need explicit overrides; the CLI does not guess
that a model supports images or native search just from its name. `/model`
refreshes the live registry. Changing the catalog does not change a saved model
identity or deliberately chosen reasoning level.

## Fields belonging elsewhere

The personal file is not a copy of the upstream catalog. These catalog-only
fields are not accepted here: `revision`, `templateRules`, `templateNameMap`,
`builtinModelIds`, `modelRules`, `modelApiRules`, `providerSiteRules`,
`templateModelRules` and `builtinProviderModelRules`. The `zai-family` and
`bigmodel-family` groups are likewise declared by native account configuration.

The old `provider`, `model.main`, `model.lite`, `models`, `modalities`, `limit` and
`modelCatalog` structures are not fields in this schema. CLI permission modes,
Plan state, retry settings, timeouts, notifications, storage paths and MCP/plugin
settings also do not belong in `provider_config.json`; see
[Configuration](CONFIGURATION.md).
