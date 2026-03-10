# ContextWeaver Skill 使用指南

本文档描述如何把 ContextWeaver MCP 的 `codebase-retrieval` 工具注册为 AI 框架的 Skill，以及编写 System Prompt 引导 LLM 正确调用和使用检索结果。

---

## 1. Tool 注册（完整 Schema）

把以下 Schema 注册到你的 AI 框架 tool registry（OpenAI function calling / Anthropic tool_use / 自定义 function spec）：

```json
{
  "name": "codebase-retrieval",
  "description": "语义检索代码仓库，返回与查询最相关的代码片段（含文件路径、行号、面包屑）。支持单项目和多子仓库聚合两种模式。",
  "parameters": {
    "type": "object",
    "required": ["repo_path", "information_request"],
    "properties": {
      "repo_path": {
        "type": "string",
        "description": "仓库根目录的绝对路径。单项目时指向该仓库目录；多项目时指向包含多个子仓库的父目录（需同时设置 multi_project=true）。"
      },
      "information_request": {
        "type": "string",
        "description": "语义目标：用完整自然语言句子描述你要找的功能、逻辑或行为，聚焦于「它是怎么工作的」而非精确名字。"
      },
      "technical_terms": {
        "type": "array",
        "items": { "type": "string" },
        "description": "精确过滤器：已知确实存在的类名、方法名、全限定名等精确标识符，用于缩小搜索范围。不确定是否存在时不要填，避免假阴性。"
      },
      "output_format": {
        "type": "string",
        "enum": ["text", "json"],
        "description": "输出格式。json（推荐）返回结构化 ContextPack，含 seedCount/fileCount/files[].segments；text 返回可读 Markdown。"
      },
      "multi_project": {
        "type": "boolean",
        "description": "多项目模式。设为 true 时，repo_path 应为包含多个已索引子仓库的父目录，工具将自动发现并聚合所有子项目的搜索结果。默认 false。"
      },
      "self_heal": {
        "type": "boolean",
        "description": "自愈重建开关。false = 若项目未索引则直接报错，不触发自动建索引（适合已提前建好索引的生产环境）。true（默认）= 未索引时自动触发建索引。"
      }
    }
  }
}
```

---

## 2. System Prompt 模板

### 2a. 单项目模式（已提前建好索引）

把 `{{REPO_PATH}}` 替换为目标仓库的绝对路径。

```
你是一名代码助手，负责回答用户关于代码仓库的问题。

## 工具使用规则

当用户询问：
- 某个方法/类的实现逻辑
- 某个功能的代码位置
- 调用链、依赖关系
- Bug 定位、代码审查

你必须先调用 `codebase-retrieval` 工具，不要猜测代码内容。

## 调用策略

1. 把用户意图写入 `information_request`（自然语言，描述"做什么"）
2. 把已知的精确符号（方法名/类名/全限定名）写入 `technical_terms`（数组）
3. 必须把 `output_format` 设为 `"json"`
4. `repo_path` 固定为：{{REPO_PATH}}
5. `self_heal` 固定为：false（索引已提前建好，禁止触发自动重建）

## 结果处理

工具返回 JSON 后：
- 取 `files[].segments` 中 `score` 最高的片段作为主要上下文
- 用 `breadcrumb` 判断代码所在的类/函数层级
- 引用时注明来源：`文件路径 (L起始行-结束行)`

## 回答格式

1. 简短结论（1-3 句，中文）
2. 关键代码片段（用三反引号包裹，附语言标识）
3. 来源标注（文件路径 + 行号区间）
4. 若检索结果不相关，建议用户提供更具体的方法名/类名
```

### 2b. 多子仓库模式（跨仓库检索，已提前建好索引）

把 `{{REPOS_ROOT}}` 替换为包含所有子仓库的父目录绝对路径。

```
你是一名代码助手，负责回答用户关于多模块 Android 工程的问题。

## 工具使用规则

当用户询问跨模块的功能、调用链、依赖关系或 Bug 时，调用 `codebase-retrieval` 工具。

## 调用策略

1. 把用户意图写入 `information_request`（自然语言）
2. 把已知精确符号写入 `technical_terms`（全限定类名优先，如 "com.xiaopeng.xpmmkv.XpMMKV#put"）
3. `output_format` 固定为 `"json"`
4. `repo_path` 固定为：{{REPOS_ROOT}}
5. `multi_project` 固定为：true
6. `self_heal` 固定为：false

## 结果处理

返回结果来自多个子仓库，`files[].path` 中包含子仓库名（如 `XPMmkv/src/...`），以此区分来源。
优先关注 `score` 较高的片段，必要时追问具体子仓库再次单独检索。

## 回答格式

1. 简短结论（1-3 句）
2. 关键代码片段（附子仓库来源）
3. 来源标注：`子仓库/文件路径 (L起始行-结束行)`
```

---

## 3. 典型调用示例

### 单项目：查询某方法实现
```json
{
  "repo_path": "/abs/path/XPBaseFramework",
  "information_request": "showBaseLoadingDialog 方法的实现逻辑，loading dialog 显示与隐藏",
  "technical_terms": ["showBaseLoadingDialog", "XPBaseActivity"],
  "output_format": "json",
  "self_heal": false
}
```

### 单项目：查询初始化流程
```json
{
  "repo_path": "/abs/path/XPBaseFramework",
  "information_request": "Application 启动时的初始化流程，onCreate 中的初始化顺序",
  "technical_terms": ["XPBaseApplication", "onCreate"],
  "output_format": "json",
  "self_heal": false
}
```

### 多项目：跨模块 Sentry 崩溃定位
```json
{
  "repo_path": "/abs/path/repos",
  "information_request": "XpMMKV.put 中对参数 key 的非空校验，Cache.put 调用链，ReconfirmDialog 的 mCurrentBiz 字段赋值",
  "technical_terms": [
    "com.xiaopeng.xpmmkv.XpMMKV#put",
    "com.xiaopeng.common.store.Cache#put",
    "com.xiaopeng.common.car.home.dialog.ReconfirmDialog"
  ],
  "output_format": "json",
  "multi_project": true,
  "self_heal": false
}
```

### 多项目：查询跨模块调用
```json
{
  "repo_path": "/abs/path/repos",
  "information_request": "BBEnv 环境类型切换的触发路径和回调机制",
  "technical_terms": ["BBEnv", "setEnvType", "BBEnvChangeListener"],
  "output_format": "json",
  "multi_project": true,
  "self_heal": false
}
```

---

## 4. 参数速查表

| 参数 | 类型 | 默认值 | 何时必填 |
|---|---|---|---|
| `repo_path` | string | — | 必填 |
| `information_request` | string | — | 必填 |
| `technical_terms` | string[] | — | 有已知精确符号时填 |
| `output_format` | `"json"` \| `"text"` | `"text"` | 程序消费时填 `"json"` |
| `multi_project` | boolean | `false` | `repo_path` 是父目录时设 `true` |
| `self_heal` | boolean | `true` | 已提前建好索引时设 `false` |

---

## 5. 注意事项与调试建议

| 场景 | 原因 | 建议 |
|---|---|---|
| 返回错误：`项目未索引（self_heal=false）` | 该子目录从未被 `contextweaver index` 索引过 | 先对该目录执行 `node dist/index.js index --config repo_map.json` 建立索引 |
| `seedCount: 0` 无命中 | 语义/词法双重未命中 | 追加更精确的 `technical_terms`（尝试全限定类名），或拆解 `information_request` 为更具体的子问题 |
| `multi_project` 结果中缺少某子仓库 | 该子仓库未索引（`~/.contextweaver/<projectId>/index.db` 不存在） | 对该子仓库单独执行 `contextweaver index` |
| 返回文档片段（`.md`）而非代码 | 项目含 repowiki 文档 | 追加精确的代码符号到 `technical_terms` 以提升代码片段权重 |
| `self_heal=true` 时首次调用很慢 | 触发了自动建索引 | 生产环境提前离线建好索引，调用时设 `self_heal: false` |
| 多项目结果过多噪音 | 38+ 仓库并发搜索，低相关仓库也返回结果 | 缩小 `repo_path` 到更具体的子集目录，或改为单项目模式指定目标子仓库 |
