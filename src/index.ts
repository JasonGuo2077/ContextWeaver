#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import './config.js';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import { generateProjectId } from './db/index.js';
import { type ScanStats, scan } from './scanner/index.js';
import { logger } from './utils/logger.js';

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

const cli = cac('contextweaver');

// 自定义版本输出，只显示版本号
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

cli.command('init', '初始化 ContextWeaver 配置').action(async () => {
  const configDir = path.join(os.homedir(), '.contextweaver');
  const envFile = path.join(configDir, '.env');

  logger.info('开始初始化 ContextWeaver...');

  // 创建配置目录
  try {
    await fs.mkdir(configDir, { recursive: true });
    logger.info(`创建配置目录: ${configDir}`);
  } catch (err) {
    const error = err as { code?: string; message?: string; stack?: string };
    if (error.code !== 'EEXIST') {
      logger.error({ err, stack: error.stack }, `创建配置目录失败: ${error.message}`);
      process.exit(1);
    }
    logger.info(`配置目录已存在: ${configDir}`);
  }

  // 检查是否已存在 .env 文件
  try {
    await fs.access(envFile);
    logger.warn(`.env 文件已存在: ${envFile}`);
    logger.info('初始化完成！');
    return;
  } catch {
    // 文件不存在，继续创建
  }

  // 写入默认 .env 配置
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

# Prompt Enhancer 配置（可选，使用 enhance 命令时需要）
# PROMPT_ENHANCER_ENDPOINT=openai
# PROMPT_ENHANCER_BASE_URL=
# PROMPT_ENHANCER_TOKEN=your-api-key-here
# PROMPT_ENHANCER_MODEL=
# PROMPT_ENHANCER_TEMPLATE=
`;
  try {
    await fs.writeFile(envFile, defaultEnvContent);
    logger.info(`创建 .env 文件: ${envFile}`);
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error({ err, stack: error.stack }, `创建 .env 文件失败: ${error.message}`);
    process.exit(1);
  }

  logger.info('下一步操作:');
  logger.info(`   1. 编辑配置文件: ${envFile}`);
  logger.info('   2. 填写你的 API Key 和其他配置');
  logger.info('初始化完成！');
});

cli
  .command('index [path]', '扫描代码库并建立索引')
  .option('-f, --force', '强制重新索引')
  .option('--multi', '当传入父目录时自动索引所有子项目（识别独立 git 仓库 / Gradle 工程）')
  .action(async (targetPath: string | undefined, options: { force?: boolean; multi?: boolean }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();

    // ── 子项目检测辅助函数 ────────────────────────────────────────────────

    /**
     * 判断一个目录是否为独立项目：
     * 1. 含 .git 目录（独立 git 仓库 ← 最优先）
     * 2. 含 Gradle 构建文件（settings.gradle.kts / build.gradle.kts 等）
     * 3. 含 Android 典型结构（app/ 子目录）
     */
    async function isProjectDir(p: string): Promise<boolean> {
      try {
        const entries = await fs.readdir(p);
        if (entries.includes('.git')) return true;
        if (
          entries.some((n) =>
            [
              'settings.gradle',
              'settings.gradle.kts',
              'build.gradle',
              'build.gradle.kts',
            ].includes(n),
          )
        )
          return true;
        if (entries.includes('app')) {
          const s = await fs.stat(path.join(p, 'app')).catch(() => null);
          if (s?.isDirectory()) return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    /**
     * 在 parent 目录下查找所有独立子项目路径。
     *
     * 策略：
     * - 若 parent 本身是项目且 --multi 未指定，直接返回 [parent]（兼容原有行为）
     * - 否则扫描一层子目录，找出所有包含 .git 或 Gradle 标识的子目录
     * - 去重后返回
     */
    async function findSubprojects(parent: string): Promise<string[]> {
      const projects = new Set<string>();

      let entries: import('fs').Dirent[] = [];
      try {
        entries = await fs.readdir(parent, { withFileTypes: true });
      } catch {
        return [parent];
      }

      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // 跳过隐藏目录（.git / .gradle 等）和常见噪音目录
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build') continue;
        const child = path.join(parent, e.name);
        if (await isProjectDir(child)) {
          projects.add(child);
        }
      }

      return Array.from(projects);
    }

    // ── 决定本次要索引的项目列表 ──────────────────────────────────────────

    let projectPaths: string[];

    const parentIsProject = await isProjectDir(rootPath);

    if (options.multi) {
      // --multi 强制模式：扫描子目录，找出所有独立子项目
      const subprojects = await findSubprojects(rootPath);
      if (subprojects.length === 0) {
        // 没找到任何子项目，降级为索引 rootPath 本身
        logger.warn(`未在 ${rootPath} 下发现子项目，将直接索引该目录`);
        projectPaths = [rootPath];
      } else {
        projectPaths = subprojects;
      }
    } else if (!parentIsProject) {
      // 非 --multi 但传入路径本身不像项目 → 自动探测子项目
      const subprojects = await findSubprojects(rootPath);
      if (subprojects.length > 0) {
        logger.info(
          `检测到 ${subprojects.length} 个子项目，将分别索引（使用 --multi 可显式指定此行为）`,
        );
        projectPaths = subprojects;
      } else {
        projectPaths = [rootPath];
      }
    } else {
      // 传入路径本身就是单个项目（原有行为）
      projectPaths = [rootPath];
    }

    // ── 逐个索引 ─────────────────────────────────────────────────────────

    logger.info(`待索引项目数量: ${projectPaths.length}`);
    if (projectPaths.length > 1) {
      for (const p of projectPaths) logger.info(`  • ${p}`);
    }

    const overallStart = Date.now();
    const overallStats: ScanStats = {
      totalFiles: 0,
      added: 0,
      modified: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    };

    for (const projPath of projectPaths) {
      const projectId = generateProjectId(projPath);
      logger.info(`▶ 开始扫描: ${projPath}  (项目 ID: ${projectId})`);
      if (options.force) logger.info('  强制重新索引: 是');

      const startTime = Date.now();
      try {
        let lastLoggedPercent = 0;
        const stats: ScanStats = await scan(projPath, {
          force: options.force,
          onProgress: (current, total, message) => {
            if (total !== undefined) {
              const percent = Math.floor((current / total) * 100);
              if (percent >= lastLoggedPercent + 30 && percent < 100) {
                logger.info(`  进度: ${percent}% - ${message || ''}`);
                lastLoggedPercent = Math.floor(percent / 30) * 30;
              }
            }
          },
        });

        process.stdout.write('\n');

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(
          `✔ 索引完成: ${projPath} (${duration}s) — 总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
        );

        // 累加到全局统计
        overallStats.totalFiles += stats.totalFiles;
        overallStats.added += stats.added;
        overallStats.modified += stats.modified;
        overallStats.unchanged += stats.unchanged;
        overallStats.deleted += stats.deleted;
        overallStats.skipped += stats.skipped;
        overallStats.errors += stats.errors;
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ err, stack: error.stack }, `✘ 索引失败: ${projPath} — ${error.message}`);
        // 单个项目失败不中断其他项目的索引
        overallStats.errors += 1;
      }
    }

    // ── 汇总输出（多项目时） ──────────────────────────────────────────────

    if (projectPaths.length > 1) {
      const overallDuration = ((Date.now() - overallStart) / 1000).toFixed(2);
      logger.info(
        `━ 全部索引完成 (${overallDuration}s) — 总计 总数:${overallStats.totalFiles} 新增:${overallStats.added} 修改:${overallStats.modified} 未变:${overallStats.unchanged} 删除:${overallStats.deleted} 跳过:${overallStats.skipped} 错误:${overallStats.errors}`,
      );
    }
  });

cli.command('mcp', '启动 MCP 服务器').action(async () => {
  // 动态导入并启动 MCP 服务器
  const { startMcpServer } = await import('./mcp/server.js');
  try {
    await startMcpServer();
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error(
      { error: error.message, stack: error.stack },
      `MCP 服务器启动失败: ${error.message}`,
    );
    process.exit(1);
  }
});

cli
  .command('enhance <prompt>', '增强提示词')
  .option('--no-browser', '直接输出到终端，不启动浏览器')
  .option('--endpoint <type>', '指定 API 端点 (openai/claude/gemini)')
  .action(
    async (
      prompt: string,
      options: {
        browser?: boolean;
        endpoint?: string;
      },
    ) => {
      const endpointRaw = options.endpoint?.toLowerCase();
      const endpointOverride =
        endpointRaw === 'openai' || endpointRaw === 'claude' || endpointRaw === 'gemini'
          ? endpointRaw
          : undefined;

      if (options.browser === false) {
        const { enhancePrompt } = await import('./enhancer/index.js');
        try {
          const result = await enhancePrompt({ prompt, endpointOverride });
          process.stdout.write(`${result.enhanced}\n`);
        } catch (err) {
          const error = err as { message?: string; stack?: string };
          logger.error(
            { error: error.message, stack: error.stack },
            `enhance 失败: ${error.message}`,
          );
          process.exit(1);
        }
        return;
      }

      const { startEnhanceServer } = await import('./enhancer/server.js');
      const { openBrowser } = await import('./enhancer/browser.js');

      try {
        const result = await startEnhanceServer(prompt, {
          endpointOverride,
          onStarted: (url) => {
            openBrowser(url);
          },
        });
        process.stdout.write(`${result.enhanced}\n`);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error(
          { error: error.message, stack: error.stack },
          `enhance 失败: ${error.message}`,
        );
        process.exit(1);
      }
    },
  );

cli
  .command('search', '本地检索（参数对齐 MCP）')
  .option('--repo-path <path>', '代码库根目录（默认当前目录）')
  .option('--information-request <text>', '自然语言问题描述（必填）')
  .option('--technical-terms <terms>', '精确术语（逗号分隔）')
  .option('--output-format <format>', '输出格式：text（默认）或 json（结构化 ContextPack）')
  .option('--zen', '使用 MCP Zen 配置（默认开启）')
  .action(
    async (options: {
      repoPath?: string;
      informationRequest?: string;
      technicalTerms?: string;
      outputFormat?: string;
      zen?: boolean;
    }) => {
      const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
      const informationRequest = options.informationRequest;
      if (!informationRequest) {
        logger.error('缺少 --information-request');
        process.exit(1);
      }

      const technicalTerms = (options.technicalTerms || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const outputFormat = (options.outputFormat === 'json' ? 'json' : 'text') as 'text' | 'json';
      const useZen = options.zen !== false;

      const { handleCodebaseRetrieval } = await import('./mcp/tools/codebaseRetrieval.js');

      const response = await handleCodebaseRetrieval(
        {
          repo_path: repoPath,
          information_request: informationRequest,
          technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
          output_format: outputFormat,
        },
        useZen ? undefined : {},
      );

      const text = response.content.map((item) => item.text).join('\n');
      process.stdout.write(`${text}\n`);
    },
  );

cli.help();
cli.parse();
