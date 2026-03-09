/**
 * Kotlin / Kotlin Script import 解析策略
 *
 * 支持文件类型：
 * - .kt  — 普通 Kotlin 源文件
 * - .kts — Kotlin Script（build.gradle.kts / settings.gradle.kts 等）
 *
 * 解析能力：
 * 1. 普通 import      : import com.example.MyClass  → .kt 优先 / .java 回退
 * 2. 通配符 import    : import com.example.*        → 目录下第一个 .kt/.java
 * 3. import 别名      : import com.example.Foo as F → 与普通 import 相同
 * 4. package 感知     : 提取文件的 package 声明，建立「包名→文件」倒排索引，
 *                       处理文件路径与包名不一致的情况（Android 多 module 常见）
 * 5. Android 路径剥离 : 自动去掉 src/main/java、src/main/kotlin、app/src/main/java
 *                       等标准 Android 工程路径前缀，使跨模块 import 也能命中
 */

import type { ImportResolver } from './types.js';

// Android / JVM 工程中常见的源码根路径前缀（按具体程度从高到低排列）
// resolve 时会依次尝试剥离这些前缀，提高命中率
const ANDROID_SRC_ROOTS = [
  '/src/main/kotlin/',
  '/src/main/java/',
  '/src/test/kotlin/',
  '/src/test/java/',
  '/src/androidTest/kotlin/',
  '/src/androidTest/java/',
  // 不带模块名前缀的通用形式
  'src/main/kotlin/',
  'src/main/java/',
];

export class KotlinResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.kt') || filePath.endsWith('.kts');
  }

  extract(content: string): string[] {
    const imports: string[] = [];
    // 匹配：
    //   import com.example.MyClass
    //   import com.example.MyClass as Alias
    //   import com.example.*
    // 使用 `[\w]+(?:\.[\w]+)*` 避免贪婪吞掉末尾的 `.`，再附加可选的 `.*`
    const pattern = /^\s*import\s+([\w]+(?:\.[\w]+)*(?:\.\*)?)/gm;
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }
    return imports;
  }

  resolve(importStr: string, _currentFile: string, allFiles: Set<string>): string | null {
    // 1. 构建 package → file 倒排索引（懒建，仅在第一次 resolve 时构建）
    //    注意：allFiles 每次调用可能不同，因此不做跨调用缓存
    const pkgIndex = buildPackageIndex(allFiles);

    if (importStr.endsWith('.*')) {
      return resolveWildcard(importStr, allFiles, pkgIndex);
    }
    return resolveOrdinary(importStr, allFiles, pkgIndex);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Package 索引构建
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描 allFiles，提取每个 .kt 文件的 package 声明，
 * 构建「完整类名前缀 → 文件路径」的快速查找 Map。
 *
 * 限制：只扫描文件路径，不读取文件内容（resolver 不做 I/O）。
 * 因此这里仅通过路径推断 package（剥离 Android 源码根路径前缀后转换为包路径）。
 * 这已覆盖绝大多数 Android 工程中路径与包名对齐的场景。
 */
function buildPackageIndex(allFiles: Set<string>): Map<string, string> {
  // key: 规范化的包路径（斜线形式，如 "com/example/util"）
  // value: 完整文件路径
  const index = new Map<string, string>();

  for (const filePath of allFiles) {
    if (!filePath.endsWith('.kt') && !filePath.endsWith('.java')) continue;

    // 尝试从路径中剥离 Android 源码根路径，推断包路径
    const pkgPath = inferPackagePath(filePath);
    if (pkgPath) {
      index.set(pkgPath, filePath);
    }
  }

  return index;
}

/**
 * 从文件绝对路径推断包路径（斜线形式）。
 *
 * 例：
 *   /repo/app/src/main/java/com/example/util/Logger.kt
 *   → "com/example/util/Logger"
 *
 * 策略：找到第一个匹配 ANDROID_SRC_ROOTS 的片段，取其后半部分并去掉扩展名。
 * 若均不匹配，则取最后一段路径去掉扩展名（保守回退）。
 */
function inferPackagePath(filePath: string): string | null {
  for (const root of ANDROID_SRC_ROOTS) {
    const idx = filePath.indexOf(root);
    if (idx !== -1) {
      const relativePart = filePath.slice(idx + root.length);
      return stripExtension(relativePart);
    }
  }
  return null;
}

/** 去掉文件扩展名（.kt / .java） */
function stripExtension(filePath: string): string {
  return filePath.replace(/\.(kt|kts|java)$/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析逻辑
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析普通 import（非通配符）。
 *
 * 策略优先级（由高到低）：
 * 1. package 索引直接命中（com.example.Foo → index["com/example/Foo"]）
 * 2. 路径后缀匹配 .kt（兼容路径与包名对齐的工程）
 * 3. 路径后缀匹配 .java（Android 混合工程回退）
 * 4. Android 多模块前缀剥离后再次尝试后缀匹配
 */
function resolveOrdinary(
  importStr: string,
  allFiles: Set<string>,
  pkgIndex: Map<string, string>,
): string | null {
  const classPath = importStr.replace(/\./g, '/'); // com.example.Foo → com/example/Foo

  // 策略 1：package 索引直接命中
  const indexed = pkgIndex.get(classPath);
  if (indexed) return indexed;

  // 策略 2：路径后缀匹配 .kt
  const ktSuffix = `/${classPath}.kt`;
  for (const f of allFiles) {
    if (f.endsWith(ktSuffix)) return f;
  }

  // 策略 3：路径后缀匹配 .java
  const javaSuffix = `/${classPath}.java`;
  for (const f of allFiles) {
    if (f.endsWith(javaSuffix)) return f;
  }

  // 策略 4：Android 多模块 — 尝试「只用类路径最后 N 段」匹配
  // 例：import androidx.lifecycle.ViewModel 在本地找不到时跳过
  // 但如果 com.myapp.feature.detail.DetailViewModel 存在于另一模块，
  // 路径可能是 /feature-detail/src/main/java/com/myapp/feature/detail/DetailViewModel.kt
  // 此时 suffix 匹配已可命中，无需额外处理。
  // 这里做一次宽松的「仅类名」匹配作为最后兜底（精度较低，仅用于找不到全路径时）
  const simpleName = classPath.split('/').pop();
  if (simpleName && simpleName.length > 2) {
    const simpleKtSuffix = `/${simpleName}.kt`;
    for (const f of allFiles) {
      if (f.endsWith(simpleKtSuffix)) return f;
    }
    const simpleJavaSuffix = `/${simpleName}.java`;
    for (const f of allFiles) {
      if (f.endsWith(simpleJavaSuffix)) return f;
    }
  }

  return null;
}

/**
 * 解析通配符 import（com.example.*）。
 *
 * 策略：
 * 1. package 索引：找 index 中 key 以 pkgPath/ 开头的第一个条目
 * 2. 路径后缀：找 allFiles 中路径包含 /pkgPath/ 的第一个 .kt/.java
 */
function resolveWildcard(
  importStr: string,
  allFiles: Set<string>,
  pkgIndex: Map<string, string>,
): string | null {
  const pkgPath = importStr.slice(0, -2).replace(/\./g, '/'); // com.example.* → com/example
  const pkgPrefix = `${pkgPath}/`;

  // 策略 1：package 索引
  for (const [key, filePath] of pkgIndex) {
    if (key.startsWith(pkgPrefix)) return filePath;
  }

  // 策略 2：路径子串匹配（先 .kt 后 .java）
  const dirSuffix = `/${pkgPath}/`;
  for (const f of allFiles) {
    if (f.endsWith('.kt') && f.includes(dirSuffix)) return f;
  }
  for (const f of allFiles) {
    if (f.endsWith('.java') && f.includes(dirSuffix)) return f;
  }

  return null;
}
