/**
 * ContextWeaver MCP Handler
 *
 * 客户端 handler 示例：
 * 1. 接收 LLM 的 tool call 参数
 * 2. 向 ContextWeaver MCP HTTP 服务发起请求
 * 3. 解析返回的 ContextPack JSON
 * 4. 把结构化结果渲染为人类可读文字，返回给 LLM 或直接输出给用户
 *
 * 使用前配置环境变量：
 *   MCP_URL=http://localhost:3000/mcp   (MCP 服务地址)
 *   MCP_AUTH_TOKEN=your-secret-token    (若启用了认证)
 */

// ─────────────────────────────────────────────
// 语言标识映射（用于代码块 fence 标记）
// ─────────────────────────────────────────────
const LANG_MAP = {
  kt: 'kotlin', kts: 'kotlin',
  java: 'java', py: 'python',
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  go: 'go', rs: 'rust', cs: 'csharp',
  swift: 'swift', cpp: 'cpp', c: 'c',
  md: 'markdown', json: 'json', xml: 'xml',
  gradle: 'groovy', sh: 'bash',
};

function detectLang(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return LANG_MAP[ext] || ext || 'plaintext';
}

// ─────────────────────────────────────────────
// 核心：向 MCP 发起调用
// ─────────────────────────────────────────────

/**
 * 调用 codebase-retrieval 工具并返回结构化 ContextPack
 *
 * @param {object} args - tool call 参数（来自 LLM）
 * @param {string} args.repo_path
 * @param {string} args.information_request
 * @param {string[]} [args.technical_terms]
 * @param {'text'|'json'} [args.output_format='json']
 * @returns {Promise<ContextPack>}
 */
export async function callCodebaseRetrieval(args) {
  const mcpUrl = process.env.MCP_URL || 'http://localhost:3000/mcp';
  const token = process.env.MCP_AUTH_TOKEN;

  const payload = {
    name: 'codebase-retrieval',
    arguments: {
      ...args,
      output_format: args.output_format || 'json',
    },
  };

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`MCP 请求失败: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();

  // MCP 返回 { content: [{ type: 'text', text: '...' }] }
  // output_format=json 时 text 字段是 JSON.stringify 的 ContextPack
  const rawText = body?.content?.[0]?.text;
  if (!rawText) throw new Error('MCP 返回格式异常：缺少 content[0].text');

  try {
    return JSON.parse(rawText);
  } catch {
    // 若 LLM 请求的是 text 格式，直接返回原始文本
    return { _rawText: rawText };
  }
}

// ─────────────────────────────────────────────
// 把 ContextPack 渲染为 LLM 可读的上下文字符串
// ─────────────────────────────────────────────

/**
 * 把 ContextPack 渲染为 Markdown 格式的上下文块，供注入 LLM prompt
 *
 * 渲染规则：
 * - 每个 segment 带文件来源标注（路径 + 行号）
 * - breadcrumb 作为代码所在的符号层级提示
 * - score 低于阈值的 segment 会带警告标记
 *
 * @param {ContextPack} pack
 * @param {object} [opts]
 * @param {number} [opts.scoreThreshold=0.3]  低于此分数加警告
 * @param {number} [opts.maxSegments=5]       最多渲染多少段
 * @returns {string}
 */
export function renderContextForLlm(pack, opts = {}) {
  const { scoreThreshold = 0.3, maxSegments = 5 } = opts;

  if (pack._rawText) return pack._rawText; // text 格式直接透传

  if (!pack.files || pack.files.length === 0) {
    return '> ⚠️ 未检索到相关代码片段。请提供更具体的方法名或类名。';
  }

  const lines = [
    `<!-- 检索到 ${pack.fileCount} 个文件，${pack.totalSegments} 段相关代码 -->`,
    '',
  ];

  let rendered = 0;
  for (const file of pack.files) {
    for (const seg of file.segments) {
      if (rendered >= maxSegments) break;
      const lang = detectLang(file.path);
      const scoreWarn = seg.score < scoreThreshold ? ' ⚠️ 低置信度' : '';
      lines.push(`### \`${file.path}\` (L${seg.startLine}-L${seg.endLine})${scoreWarn}`);
      if (seg.breadcrumb) lines.push(`> ${seg.breadcrumb}`);
      lines.push('');
      lines.push('```' + lang);
      lines.push((seg.text || '').trimEnd());
      lines.push('```');
      lines.push('');
      rendered++;
    }
    if (rendered >= maxSegments) break;
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// 把 ContextPack 渲染为最终用户可读的回复
// ─────────────────────────────────────────────

/**
 * 把 ContextPack 渲染为面向用户的回复（非 LLM 中间层，直接展示给用户）
 *
 * @param {ContextPack} pack
 * @returns {string}
 */
export function renderAnswerForUser(pack) {
  if (pack._rawText) return pack._rawText;

  if (!pack.files || pack.files.length === 0) {
    return '未检索到相关代码片段，请提供更具体的方法名或类名。';
  }

  const lines = [
    `检索到 **${pack.fileCount}** 个文件，**${pack.totalSegments}** 段相关代码。`,
    '',
  ];

  for (const file of pack.files) {
    for (const seg of file.segments) {
      const lang = detectLang(file.path);
      lines.push(`**来源：** \`${file.path}\` (L${seg.startLine}-L${seg.endLine})`);
      if (seg.breadcrumb) lines.push(`**位置：** ${seg.breadcrumb}`);
      lines.push('');
      lines.push('```' + lang);
      lines.push((seg.text || '').trimEnd());
      lines.push('```');
      lines.push('');
    }
  }

  lines.push(`_检索耗时：retrieve ${pack.timingMs?.retrieve ?? '-'}ms / rerank ${pack.timingMs?.rerank ?? '-'}ms_`);
  return lines.join('\n');
}
