# ContextWeaver Skill 使用指南

本文档描述如何把 ContextWeaver MCP 的 `codebase-retrieval` 工具注册为 AI 框架的 Skill，以及编写 System Prompt 引导 LLM 正确调用和使用检索结果。

---

## 1. Tool 注册（tool-schema.json）

把 `tool-schema.json` 注册到你的 AI 框架 tool registry（OpenAI function calling / Anthropic tool_use / 自定义 function spec），让 LLM 知道该工具的名称、参数与用途。

```json
// 参见 tool-schema.json
{
  "name": "codebase-retrieval",
  "description": "...",
  "parameters": { ... }
}
```

---

## 2. System Prompt 模板

在 Skill 初始化时把以下内容注入为系统提示。把 `{{REPO_PATH}}` 替换为目标仓库的绝对路径。

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
2. 把已知的精确符号（方法名/类名）写入 `technical_terms`（数组）
3. 必须把 `output_format` 设为 `"json"`
4. `repo_path` 固定为：{{REPO_PATH}}

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

---

## 3. 典型查询示例

### 查询某方法实现
```
用户: showBaseLoadingDialog 这个方法是怎么实现的？

→ LLM 调用工具:
{
  "repo_path": "/abs/path/XPBaseFramework",
  "information_request": "showBaseLoadingDialog 方法的实现逻辑，loading dialog 显示与隐藏",
  "technical_terms": ["showBaseLoadingDialog", "XPBaseActivity"],
  "output_format": "json"
}
```

### 查询初始化流程
```
用户: Application 的初始化流程是怎样的？

→ LLM 调用工具:
{
  "repo_path": "/abs/path/XPBaseFramework",
  "information_request": "Application 启动时的初始化流程，onCreate 中的初始化顺序",
  "technical_terms": ["XPBaseApplication", "onCreate"],
  "output_format": "json"
}
```

### 查询跨模块调用
```
用户: BBEnv 的环境切换是怎么触发的？

→ LLM 调用工具:
{
  "repo_path": "/abs/path/BBox",
  "information_request": "BBEnv 环境类型切换的触发路径和回调机制",
  "technical_terms": ["BBEnv", "setEnvType", "BBEnvChangeListener"],
  "output_format": "json"
}
```

---

## 4. 注意事项

| 场景 | 建议 |
|---|---|
| 结果 score < 0.3 | 追加更精确的 `technical_terms` 或换更具体的 `information_request` |
| 返回文档片段（.md）而非代码 | 项目含 repowiki；可追加 `technical_terms` 强制偏向代码符号 |
| 多个仓库需要同时检索 | 分别调用两次（每次不同 `repo_path`），合并结果 |
| 首次使用新仓库 | MCP 会自动触发索引（首次较慢，约 5-30s 取决于仓库大小） |
