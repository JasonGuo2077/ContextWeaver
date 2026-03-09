# Demo Workflow：AI 框架接入 ContextWeaver MCP

本文档展示一个完整的调用链：用户提问 → LLM 决策调用工具 → handler 请求 MCP → 解析结果 → LLM 生成最终回答。

---

## 调用链总览

```
用户提问
  │
  ▼
AI 框架（LLM）
  │  根据 System Prompt 和 Tool Schema
  │  决定调用 codebase-retrieval
  ▼
handler.js（客户端 handler）
  │  POST http://localhost:3000/mcp
  │  { name: "codebase-retrieval", arguments: { ... } }
  ▼
ContextWeaver MCP 服务（本地 stdio 或 HTTP）
  │  向量检索 + FTS + RRF 融合 + Rerank + GraphExpander
  ▼
返回 ContextPack JSON
  │  { seedCount, expandedCount, files[].segments[].{text,score,breadcrumb,lines}, timingMs }
  ▼
handler 渲染为 Markdown 上下文块
  │  注入 LLM 的下一轮 prompt（作为 tool result）
  ▼
LLM 生成最终回答（含代码引用与来源标注）
  │
  ▼
用户看到结果
```

---

## 环境准备

```bash
# 1. 启动 ContextWeaver MCP（stdio 模式，供本地 AI 客户端调用）
node /home/xpeng/workplace/ai_workplace/ContextWeaver/dist/index.js mcp

# 或 HTTP 模式（供网络上的 AI 框架访问，需实现 --http 支持）
# MCP_AUTH_TOKEN=my-secret node dist/index.js mcp --http --port 3000

# 2. 确保索引已完成
node dist/index.js index /abs/path/to/XPBaseFramework
node dist/index.js index /abs/path/to/BBox
```

---

## 完整代码示例（Node.js）

```javascript
// demo/run.js
// 模拟一次完整的 AI 框架 → MCP 调用流程
// 运行：MCP_URL=http://localhost:3000/mcp node docs/demo/run.js

import { callCodebaseRetrieval, renderContextForLlm, renderAnswerForUser } from './handler.js';

// ─── 模拟 LLM 的 tool call 参数 ───────────────────────────────
const toolCallArgs = {
  repo_path: '/home/xpeng/workplace/sentry_place/test_context_weaver/XPBaseFramework',
  information_request: 'showBaseLoadingDialog 方法的实现逻辑，loading dialog 的显示与隐藏',
  technical_terms: ['showBaseLoadingDialog', 'XPBaseActivity'],
  output_format: 'json',
};

async function main() {
  console.log('▶ Step 1: 调用 MCP codebase-retrieval...\n');
  const pack = await callCodebaseRetrieval(toolCallArgs);

  console.log('▶ Step 2: ContextPack 摘要');
  console.log(`  seedCount:     ${pack.seedCount}`);
  console.log(`  expandedCount: ${pack.expandedCount}`);
  console.log(`  fileCount:     ${pack.fileCount}`);
  console.log(`  totalSegments: ${pack.totalSegments}`);
  console.log(`  timingMs:      ${JSON.stringify(pack.timingMs)}\n`);

  // ─── 路径 A：把结果作为上下文注入 LLM 的 tool result ──────────
  console.log('▶ Step 3A: 渲染为 LLM 上下文块（注入 tool result）\n');
  const llmContext = renderContextForLlm(pack, { scoreThreshold: 0.3, maxSegments: 3 });
  console.log(llmContext);

  // ─── 路径 B：直接渲染为用户可读回答（跳过第二次 LLM） ─────────
  console.log('\n▶ Step 3B: 渲染为用户回答（直接展示）\n');
  const userAnswer = renderAnswerForUser(pack);
  console.log(userAnswer);
}

main().catch(console.error);
```

---

## 路径 A：注入 LLM 再生成回答（推荐）

适合需要 LLM 综合多段代码并生成自然语言解释的场景。

```
┌──────────────────────────────────────────────────────┐
│  messages = [                                         │
│    { role: "system",   content: SKILL_SYSTEM_PROMPT } │
│    { role: "user",     content: "showBaseLoadingDialog 怎么实现？" }  │
│    { role: "assistant",content: null,                 │    ← LLM 返回 tool_call
│      tool_calls: [{ name: "codebase-retrieval", args: {...} }] }      │
│    { role: "tool",     content: llmContext }           │    ← handler 执行后填入
│  ]                                                    │
│                                                       │
│  → 再次调用 LLM → 生成最终回答                          │
└──────────────────────────────────────────────────────┘
```

伪代码：
```javascript
// 第一轮：LLM 决定调用工具
const r1 = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  tools: [toolSchema],          // 注册 codebase-retrieval tool
  tool_choice: 'auto',
});

// handler 执行 tool call
const toolCall = r1.choices[0].message.tool_calls[0];
const args = JSON.parse(toolCall.function.arguments);
const pack = await callCodebaseRetrieval(args);
const context = renderContextForLlm(pack);

// 第二轮：LLM 基于检索结果生成回答
messages.push(r1.choices[0].message);
messages.push({ role: 'tool', tool_call_id: toolCall.id, content: context });
const r2 = await openai.chat.completions.create({ model: 'gpt-4o', messages });
console.log(r2.choices[0].message.content);
```

---

## 路径 B：直接渲染（跳过第二次 LLM）

适合需要精确代码定位而非生成解释的场景（速度更快、Token 更省）。

```javascript
const pack = await callCodebaseRetrieval(args);
// 直接展示给用户，无需再次调用 LLM
console.log(renderAnswerForUser(pack));
```

---

## ContextPack JSON 字段说明

```json
{
  "seedCount": 2,           // 初始召回的种子 chunk 数量
  "expandedCount": 8,       // 扩展后（邻居/breadcrumb/import）的 chunk 总数
  "fileCount": 1,           // 最终打包的文件数
  "totalSegments": 2,       // 所有文件的段落总数
  "files": [
    {
      "path": "base/src/main/kotlin/com/example/XPBaseActivity.kt",
      "segments": [
        {
          "startLine": 45,          // 段起始行（1-indexed）
          "endLine": 72,            // 段结束行
          "score": 0.993,           // Reranker 置信度（0-1，越高越相关）
          "breadcrumb": "XPBaseActivity > showBaseLoadingDialog",  // 符号层级
          "text": "fun showBaseLoadingDialog(...) { ... }"         // 代码文本
        }
      ]
    }
  ],
  "timingMs": {
    "retrieve": 80,     // 向量+FTS 召回耗时
    "rerank": 300,      // Reranker 精排耗时
    "expand": 20,       // GraphExpander 上下文扩展耗时
    "pack": 3           // ContextPacker 打包耗时
  }
}
```

---

## 常见问题

| 问题 | 排查 |
|---|---|
| score 普遍低于 0.3 | 换更具体的 `information_request` 或追加 `technical_terms` |
| 返回 .md 文档而非代码 | 加 `technical_terms` 强制偏向代码符号 |
| 首次查询很慢（30s+） | 首次使用新仓库需自动触发全量索引，后续是增量更新（< 1s） |
| MCP 连接失败 | 确认 `contextweaver mcp` 进程在运行，检查端口和 token 配置 |
| 返回内容截断 | `maxSegments` 或 token budget 设置过小，适当调大 |
