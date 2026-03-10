/**
 * codebase-retrieval MCP Tool
 *
 * 极简主义 (Zen Design) 代码检索工具
 *
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 黄金默认值：提供同文件上下文，禁止跨文件抓取
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { generateProjectId } from '../../db/index.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { ContextPack, SearchConfig, Segment, ScoredChunk } from '../../search/types.js';
import { logger } from '../../utils/logger.js';

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
  output_format: z
    .enum(['text', 'json'])
    .optional()
    .describe(
      "Output format. 'text' (default): human-readable markdown with code blocks. 'json': structured ContextPack object with seedCount, expandedCount, files, segments, timingMs — ideal for programmatic consumption.",
    ),
  multi_project: z
    .boolean()
    .optional()
    .describe(
      "Set to true when repo_path is a parent directory containing multiple indexed sub-repositories. The search will aggregate results across all indexed sub-projects found under repo_path. Default: false (treat repo_path as a single project).",
    ),
  self_heal: z
    .boolean()
    .optional()
    .describe(
      "Set to false to skip automatic index creation/repair. When false, if a project is not yet indexed, the tool will return an error instead of triggering indexing. Default: true (auto-index on first use).",
    ),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

// 默认配置 (Zen Config)

/**
 * MCP 工具专用配置覆盖
 *
 * 目标：提供足够看懂当前文件的上下文，但不跨文件
 */
const ZEN_CONFIG_OVERRIDE: Partial<SearchConfig> = {
  // E1: 邻居扩展 - 前后看 2 个 chunk，保证代码块完整性
  neighborHops: 2,

  // E2: 面包屑补全 - 必须开启，保证能看到当前方法所属的 Class/Function 定义
  breadcrumbExpandLimit: 3,

  // E3: Import 扩展 - 强制关闭！
  // 理由：跨文件是 Agent 的决策，不要预加载，防止 Token 爆炸
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
};

// ===========================================
// 自动索引逻辑
// ===========================================

const BASE_DIR = path.join(os.homedir(), '.contextweaver');

/**
 * 确保默认 .env 文件存在
 *
 * 如果 ~/.contextweaver/.env 不存在，则创建包含默认配置的文件
 */
async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  // 检查文件是否已存在
  if (fs.existsSync(envFile)) {
    return;
  }

  // 创建配置目录
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  // 写入默认配置
  const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules

# Prompt Enhancer 配置（可选，使用 enhance-prompt 工具时需要）
# PROMPT_ENHANCER_ENDPOINT=openai
# PROMPT_ENHANCER_BASE_URL=
# PROMPT_ENHANCER_TOKEN=your-api-key-here
# PROMPT_ENHANCER_MODEL=
# PROMPT_ENHANCER_TEMPLATE=
`;

  fs.writeFileSync(envFile, defaultEnvContent);
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

/**
 * 检测代码库是否已初始化（数据库是否存在）
 */
function isProjectIndexed(projectId: string): boolean {
  const dbPath = path.join(BASE_DIR, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

/**
 * 扫描 parentPath 下所有子目录，找出已建立索引的子项目
 * 返回 Array<{ subPath, projectId }>
 */
function findIndexedSubProjects(
  parentPath: string,
): Array<{ subPath: string; projectId: string }> {
  const result: Array<{ subPath: string; projectId: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(parentPath);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const subPath = path.join(parentPath, entry);
    try {
      const stat = fs.statSync(subPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const projectId = generateProjectId(subPath);
    if (isProjectIndexed(projectId)) {
      result.push({ subPath, projectId });
    }
  }
  return result;
}

/**
 * 确保代码库已索引
 *
 * 策略：
 * - 如果 selfHeal=false 且数据库不存在，直接抛出错误
 * - 如果代码库未初始化（数据库不存在），执行完整索引
 * - 如果已初始化，执行增量索引（只索引变更的文件）
 * - 使用文件锁防止多进程竞态
 *
 * @param repoPath 代码库路径
 * @param projectId 项目 ID
 * @param selfHeal 是否允许自动创建/修复索引（默认 true）
 * @param onProgress 可选的进度回调
 */
async function ensureIndexed(
  repoPath: string,
  projectId: string,
  selfHeal = true,
  onProgress?: (current: number, total?: number, message?: string) => void,
): Promise<void> {
  // self_heal=false 时，未索引直接报错，不触发重建
  if (!selfHeal) {
    if (!isProjectIndexed(projectId)) {
      throw new Error(
        `项目未索引（self_heal=false）: ${repoPath}（projectId=${projectId.slice(0, 10)}）。请先运行 contextweaver index 建立索引。`,
      );
    }
    logger.debug({ projectId: projectId.slice(0, 10) }, 'self_heal=false，跳过自愈检查');
    return;
  }

  // 延迟导入锁和 scan 函数（避免 MCP 启动时加载 native 模块）
  const { withLock } = await import('../../utils/lock.js');
  const { scan } = await import('../../scanner/index.js');

  await withLock(projectId, 'index', async () => {
    const wasIndexed = isProjectIndexed(projectId);

    if (!wasIndexed) {
      logger.info(
        { repoPath, projectId: projectId.slice(0, 10) },
        '代码库未初始化，开始首次索引...',
      );
      onProgress?.(0, 100, '代码库未索引，开始首次索引...');
    } else {
      logger.debug({ projectId: projectId.slice(0, 10) }, '执行增量索引...');
    }

    const startTime = Date.now();
    const stats = await scan(repoPath, { vectorIndex: true, onProgress });
    const elapsed = Date.now() - startTime;

    logger.info(
      {
        projectId: projectId.slice(0, 10),
        isFirstTime: !wasIndexed,
        totalFiles: stats.totalFiles,
        added: stats.added,
        modified: stats.modified,
        deleted: stats.deleted,
        vectorIndex: stats.vectorIndex,
        elapsedMs: elapsed,
      },
      '索引完成',
    );
  });
}

// 工具处理函数

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

/**
 * 处理 codebase-retrieval 工具调用
 *
 * @param args 工具输入参数
 * @param configOverride 可选的配置覆盖
 * @param onProgress 可选的进度回调（用于 MCP 进度通知）
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  configOverride: Partial<SearchConfig> = ZEN_CONFIG_OVERRIDE,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    repo_path,
    information_request,
    technical_terms,
    output_format = 'text',
    multi_project = false,
    self_heal = true,
  } = args;

  logger.info(
    {
      repo_path,
      information_request,
      technical_terms,
      multi_project,
      self_heal,
    },
    'MCP codebase-retrieval 调用开始',
  );

  // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ missingVars: allMissingVars }, 'MCP 环境变量未配置');
    await ensureDefaultEnvFile();
    return formatEnvMissingResponse(allMissingVars);
  }

  // 合并查询（semantic + technical terms）
  const query = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');

  // =========================================
  // 多项目聚合模式
  // =========================================
  if (multi_project) {
    const subProjects = findIndexedSubProjects(repo_path);

    if (subProjects.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `multi_project=true 但在 ${repo_path} 下未找到任何已索引的子项目。请先运行 contextweaver index 对各子目录建立索引。`,
          },
        ],
      };
    }

    logger.info(
      {
        repo_path,
        subProjectCount: subProjects.length,
        subProjects: subProjects.map((p) => ({ path: p.subPath, id: p.projectId.slice(0, 10) })),
      },
      'MCP 多项目聚合搜索',
    );

    const { SearchService } = await import('../../search/SearchService.js');

    // ── 阶段一：并发轻量召回（各子项目只做向量+FTS，不 rerank）────────────────
    const t1 = Date.now();
    const retrieveResults = await Promise.allSettled(
      subProjects.map(async ({ subPath, projectId }) => {
        const service = new SearchService(projectId, subPath, configOverride);
        await service.init();
        const candidates = await service.retrieveOnly(query);
        return { subPath, projectId, service, candidates };
      }),
    );

    // 收集成功的召回结果
    // 用 _projectId 临时字段给每个 candidate 打标（spread 到 rerank 结果时会保留）
    let successCount = 0;
    const allCandidates: (ScoredChunk & { _projectId: string })[] = [];
    const serviceMap = new Map<string, InstanceType<typeof SearchService>>();

    for (const result of retrieveResults) {
      if (result.status === 'fulfilled') {
        successCount++;
        serviceMap.set(result.value.projectId, result.value.service);
        for (const c of result.value.candidates) {
          allCandidates.push({ ...c, _projectId: result.value.projectId });
        }
      } else {
        logger.warn({ reason: String(result.reason) }, '子项目召回失败');
      }
    }

    logger.info(
      {
        subProjectCount: subProjects.length,
        successCount,
        totalCandidates: allCandidates.length,
        retrieveMs: Date.now() - t1,
      },
      'MCP 多项目阶段一召回完成',
    );

    if (serviceMap.size === 0 || allCandidates.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `多项目搜索：${successCount}/${subProjects.length} 个子项目召回完成，但无任何候选结果。请检查查询词或确认各子项目已正确索引。`,
          },
        ],
      };
    }

    // ── 阶段二：全局一次 rerank（rerank 只依赖文本内容，不依赖 DB，任选一个 service）
    const t2 = Date.now();
    const anchorService = serviceMap.values().next().value as InstanceType<typeof SearchService>;
    // rerankAndCutoff 内部 spread 时会保留 _projectId 字段
    const globalSeeds = (await anchorService.rerankAndCutoff(
      query,
      allCandidates,
    )) as (ScoredChunk & { _projectId?: string })[];
    logger.info({ rerankMs: Date.now() - t2, seedCount: globalSeeds.length }, 'MCP 多项目阶段二全局 rerank 完成');

    // ── 阶段三：按子项目分组 expand + pack ──────────────────────────────────────
    const t3 = Date.now();
    const seedsByProject = new Map<string, ScoredChunk[]>();
    for (const seed of globalSeeds) {
      const pid = seed._projectId;
      if (!pid) continue;
      if (!seedsByProject.has(pid)) seedsByProject.set(pid, []);
      seedsByProject.get(pid)!.push(seed);
    }

    // 各子项目并发 expand+pack
    const packResults = await Promise.allSettled(
      Array.from(seedsByProject.entries()).map(async ([pid, seeds]) => {
        const svc = serviceMap.get(pid)!;
        return svc.expandAndPack(query, seeds);
      }),
    );

    const successPacks: ContextPack[] = [];
    for (const r of packResults) {
      if (r.status === 'fulfilled') successPacks.push(r.value);
      else logger.warn({ reason: String(r.reason) }, '子项目 expand+pack 失败');
    }

    const mergedPack = mergeContextPacks(successPacks, query);
    // 合并后的 seeds 要用全局 rerank 后的（包含所有子项目的 seeds）
    mergedPack.seeds = globalSeeds;

    logger.info(
      {
        subProjectCount: subProjects.length,
        successCount,
        seedCount: globalSeeds.length,
        fileCount: mergedPack.files.length,
        expandAndPackMs: Date.now() - t3,
      },
      'MCP 多项目聚合完成',
    );

    return formatMcpResponse(mergedPack, output_format);
  }

  // =========================================
  // 单项目模式
  // =========================================
  const projectId = generateProjectId(repo_path);

  // 自愈检查（单项目模式）
  await ensureIndexed(repo_path, projectId, self_heal, onProgress);

  logger.info(
    {
      projectId: projectId.slice(0, 10),
      query,
      zenConfig: configOverride,
    },
    'MCP 查询构建',
  );

  const { SearchService } = await import('../../search/SearchService.js');
  const service = new SearchService(projectId, repo_path, configOverride);
  await service.init();
  logger.debug('SearchService 初始化完成');

  const contextPack = await service.buildContextPack(query);

  // 详细日志：seeds 信息
  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        seeds: contextPack.seeds.map((s) => ({
          file: s.filePath,
          chunk: s.chunkIndex,
          score: s.score.toFixed(4),
          source: s.source,
        })),
      },
      'MCP 搜索 seeds',
    );
  } else {
    logger.warn('MCP 搜索无 seeds 命中');
  }

  // 详细日志：扩展结果
  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((e) => ({
          file: e.filePath,
          chunk: e.chunkIndex,
          score: e.score.toFixed(4),
        })),
      },
      'MCP 扩展结果 (前5)',
    );
  }

  // 详细日志：打包后的文件段落
  logger.info(
    {
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
      totalSegments: contextPack.files.reduce((acc, f) => acc + f.segments.length, 0),
      files: contextPack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.length,
        lines: f.segments.map((s) => `L${s.startLine}-${s.endLine}`),
      })),
      timingMs: contextPack.debug?.timingMs,
    },
    'MCP codebase-retrieval 完成',
  );

  return formatMcpResponse(contextPack, output_format);
}

/**
 * 合并多个 ContextPack 为一个（多项目聚合用）
 *
 * 策略：
 * - seeds/expanded 按 score 全局排序后取 top N
 * - files 段落去重（相同 filePath+startLine 只保留一份）
 */
function mergeContextPacks(packs: ContextPack[], query: string): ContextPack {
  if (packs.length === 0) {
    return { query, seeds: [], expanded: [], files: [], debug: { wVec: 0, wLex: 0, timingMs: {} } };
  }
  if (packs.length === 1) return packs[0];

  const allSeeds = packs.flatMap((p) => p.seeds).sort((a, b) => b.score - a.score);
  const allExpanded = packs.flatMap((p) => p.expanded).sort((a, b) => b.score - a.score);

  // 文件段落去重：key = filePath + startLine
  const seenSegments = new Set<string>();
  const mergedFiles: ContextPack['files'] = [];

  for (const pack of packs) {
    for (const file of pack.files) {
      const dedupedSegments = file.segments.filter((seg) => {
        const key = `${file.filePath}:${seg.startLine}`;
        if (seenSegments.has(key)) return false;
        seenSegments.add(key);
        return true;
      });
      if (dedupedSegments.length > 0) {
        // 检查是否已有该文件
        const existing = mergedFiles.find((f) => f.filePath === file.filePath);
        if (existing) {
          existing.segments.push(...dedupedSegments);
        } else {
          mergedFiles.push({ ...file, segments: dedupedSegments });
        }
      }
    }
  }

  return {
    query,
    seeds: allSeeds,
    expanded: allExpanded,
    files: mergedFiles,
    debug: { wVec: packs[0].debug?.wVec ?? 0, wLex: packs[0].debug?.wLex ?? 0, timingMs: {} },
  };
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 *
 * @param pack ContextPack 搜索结果
 * @param outputFormat 'text'（默认）返回可读 Markdown；'json' 返回结构化 JSON
 */
function formatMcpResponse(
  pack: ContextPack,
  outputFormat: 'text' | 'json' = 'text',
): { content: Array<{ type: 'text'; text: string }> } {
  if (outputFormat === 'json') {
    const structured = {
      seedCount: pack.seeds.length,
      expandedCount: pack.expanded.length,
      fileCount: pack.files.length,
      totalSegments: pack.files.reduce((acc, f) => acc + f.segments.length, 0),
      files: pack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.map((s) => ({
          startLine: s.startLine,
          endLine: s.endLine,
          score: s.score,
          breadcrumb: s.breadcrumb,
          text: s.text,
        })),
      })),
      timingMs: pack.debug?.timingMs ?? {},
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structured, null, 2),
        },
      ],
    };
  }

  const { files, seeds } = pack;

  // 构建文件内容块
  const fileBlocks = files
    .map((file) => {
      const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
      return segments;
    })
    .join('\n\n---\n\n');

  // 构建摘要
  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

  const text = `${summary}\n\n${fileBlocks}`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * 格式化单个代码段
 */
function formatSegment(seg: Segment): string {
  const lang = detectLanguage(seg.filePath);
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * 格式化环境变量缺失的响应
 *
 * 当用户未配置必需的环境变量时，返回友好的提示信息
 */
function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextweaver/.env';

  const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here  # ← 替换为你的 API Key

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here      # ← 替换为你的 API Key
\`\`\`

保存文件后重新调用此工具即可。
`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}
