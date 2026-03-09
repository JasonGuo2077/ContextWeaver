/**
 * Kotlin 支持相关测试
 *
 * 覆盖：
 * 1. KotlinResolver — import 解析、.kt/.java 回退、.kts 支持、package 感知、多模块路径剥离
 * 2. LanguageSpec   — kotlin 条目是否存在且关键字段正确
 * 3. ParserPool     — 是否能成功加载并使用 tree-sitter-kotlin 解析一段 Kotlin 代码
 * 4. SemanticSplitter — 基于 AST 分片 Kotlin 源文件
 * 5. language.ts    — .kts 是否被识别为 kotlin
 */

import { describe, it, expect } from 'vitest';
import { KotlinResolver } from '../../src/search/resolvers/KotlinResolver.js';
import { getLanguageSpec } from '../../src/chunking/LanguageSpec.js';
import { getParser, isLanguageSupported } from '../../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../../src/chunking/SemanticSplitter.js';
import { getLanguage, isAllowedExtension } from '../../src/scanner/language.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. KotlinResolver
// ─────────────────────────────────────────────────────────────────────────────
describe('KotlinResolver', () => {
  const resolver = new KotlinResolver();

  // ── supports ──
  it('supports .kt files', () => {
    expect(resolver.supports('/src/main/com/example/Main.kt')).toBe(true);
  });

  it('supports .kts files (Kotlin Script / Gradle DSL)', () => {
    expect(resolver.supports('/app/build.gradle.kts')).toBe(true);
    expect(resolver.supports('/settings.gradle.kts')).toBe(true);
  });

  it('does not support .java or .ts files', () => {
    expect(resolver.supports('/src/main/com/example/Main.java')).toBe(false);
    expect(resolver.supports('/src/index.ts')).toBe(false);
  });

  // ── extract ──
  it('extracts ordinary imports', () => {
    const src = `
package com.example.app

import android.os.Bundle
import android.app.Activity
import com.example.util.Logger
`;
    const imports = resolver.extract(src);
    expect(imports).toContain('android.os.Bundle');
    expect(imports).toContain('android.app.Activity');
    expect(imports).toContain('com.example.util.Logger');
  });

  it('extracts wildcard imports', () => {
    const src = `import com.example.util.*\nimport android.widget.*`;
    const imports = resolver.extract(src);
    expect(imports).toContain('com.example.util.*');
    expect(imports).toContain('android.widget.*');
  });

  it('extracts aliased imports (captures package path, not alias)', () => {
    const src = `import com.example.Foo as Bar`;
    const imports = resolver.extract(src);
    expect(imports).toContain('com.example.Foo');
    expect(imports).not.toContain('com.example.Foo as Bar');
  });

  // ── resolve: basic suffix match ──
  it('resolves ordinary import to .kt file via suffix match', () => {
    const files = new Set([
      '/repo/src/main/java/com/example/util/Logger.kt',
      '/repo/src/main/java/com/example/app/MainActivity.kt',
    ]);
    const result = resolver.resolve('com.example.util.Logger', '/repo/src/main/java/com/example/app/MainActivity.kt', files);
    expect(result).toBe('/repo/src/main/java/com/example/util/Logger.kt');
  });

  it('falls back to .java when no .kt is found', () => {
    const files = new Set([
      '/repo/src/main/java/com/example/util/Utils.java',
      '/repo/src/main/java/com/example/app/MainActivity.kt',
    ]);
    const result = resolver.resolve('com.example.util.Utils', '/repo/src/main/java/com/example/app/MainActivity.kt', files);
    expect(result).toBe('/repo/src/main/java/com/example/util/Utils.java');
  });

  it('resolves wildcard import to a .kt file in the package directory', () => {
    const files = new Set([
      '/repo/src/main/java/com/example/util/Logger.kt',
      '/repo/src/main/java/com/example/util/FileUtil.kt',
    ]);
    const result = resolver.resolve('com.example.util.*', '/repo/src/main/java/com/example/app/MainActivity.kt', files);
    expect(result).toBeTruthy();
    expect(result?.endsWith('.kt')).toBe(true);
  });

  it('returns null for completely unresolvable import', () => {
    const files = new Set(['/repo/src/main/java/com/other/Thing.kt']);
    const result = resolver.resolve('com.example.missing.Class', '/repo/src/MainActivity.kt', files);
    expect(result).toBeNull();
  });

  // ── resolve: Android 多模块路径（package 感知 + 前缀剥离）──
  it('resolves via Android src/main/kotlin root prefix stripping', () => {
    // feature-login 模块路径：路径中含 src/main/kotlin，包名可直接推断
    const files = new Set([
      '/repo/feature-login/src/main/kotlin/com/example/login/LoginViewModel.kt',
      '/repo/app/src/main/kotlin/com/example/app/MainActivity.kt',
    ]);
    const result = resolver.resolve(
      'com.example.login.LoginViewModel',
      '/repo/app/src/main/kotlin/com/example/app/MainActivity.kt',
      files,
    );
    expect(result).toBe('/repo/feature-login/src/main/kotlin/com/example/login/LoginViewModel.kt');
  });

  it('resolves via Android src/main/java root prefix stripping (cross-module)', () => {
    const files = new Set([
      '/repo/data/src/main/java/com/example/data/Repository.kt',
      '/repo/app/src/main/java/com/example/app/MainActivity.kt',
    ]);
    const result = resolver.resolve(
      'com.example.data.Repository',
      '/repo/app/src/main/java/com/example/app/MainActivity.kt',
      files,
    );
    expect(result).toBe('/repo/data/src/main/java/com/example/data/Repository.kt');
  });

  it('falls back to simple class name match when full path is unavailable', () => {
    // 工程中只有 DetailViewModel.kt 但路径不含标准 Android src 根
    const files = new Set([
      '/custom-layout/gen/com/example/detail/DetailViewModel.kt',
    ]);
    const result = resolver.resolve(
      'com.example.detail.DetailViewModel',
      '/app/src/main/kotlin/com/example/app/MainActivity.kt',
      files,
    );
    expect(result).toBe('/custom-layout/gen/com/example/detail/DetailViewModel.kt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LanguageSpec — kotlin 条目
// ─────────────────────────────────────────────────────────────────────────────
describe('LanguageSpec - kotlin', () => {
  const spec = getLanguageSpec('kotlin');

  it('returns a non-null spec for kotlin', () => {
    expect(spec).not.toBeNull();
  });

  it('hierarchy includes key Kotlin node types', () => {
    expect(spec?.hierarchy.has('class_declaration')).toBe(true);
    expect(spec?.hierarchy.has('object_declaration')).toBe(true);
    expect(spec?.hierarchy.has('function_declaration')).toBe(true);
    expect(spec?.hierarchy.has('companion_object')).toBe(true);
  });

  it('nameNodeTypes includes simple_identifier', () => {
    expect(spec?.nameNodeTypes.has('simple_identifier')).toBe(true);
  });

  it('commentTypes includes line_comment and multiline_comment', () => {
    expect(spec?.commentTypes.has('line_comment')).toBe(true);
    expect(spec?.commentTypes.has('multiline_comment')).toBe(true);
  });

  it('prefixMap has correct prefixes', () => {
    expect(spec?.prefixMap['class_declaration']).toBe('class ');
    expect(spec?.prefixMap['function_declaration']).toBe('fun ');
    expect(spec?.prefixMap['object_declaration']).toBe('object ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ParserPool — 加载 Kotlin grammar
// ─────────────────────────────────────────────────────────────────────────────
describe('ParserPool - kotlin', () => {
  it('reports kotlin as supported language', () => {
    expect(isLanguageSupported('kotlin')).toBe(true);
  });

  it('can load kotlin parser and parse a snippet', async () => {
    const parser = await getParser('kotlin');
    expect(parser).not.toBeNull();

    const src = `
fun main() {
    println("Hello, Android!")
}
`.trim();
    const tree = parser!.parse(src);
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe('source_file');
    // hasError 在某些 tree-sitter 版本中是属性，不是方法
    expect(tree.rootNode.hasError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SemanticSplitter — Kotlin AST 分片
// ─────────────────────────────────────────────────────────────────────────────
describe('SemanticSplitter - kotlin', () => {
  const kotlinSrc = `
package com.example.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * MainActivity — entry point of the Android app.
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }

    private fun greet(name: String): String {
        return "Hello, $name!"
    }
}

object AppConfig {
    const val VERSION = "1.0.0"
    const val DEBUG = true
}
`.trim();

  it('produces chunks from Kotlin source using AST', async () => {
    const parser = await getParser('kotlin');
    expect(parser).not.toBeNull();

    const tree = parser!.parse(kotlinSrc);
    const splitter = new SemanticSplitter({ maxChunkSize: 300 });
    const chunks = splitter.split(tree, kotlinSrc, 'MainActivity.kt', 'kotlin');

    expect(chunks.length).toBeGreaterThan(0);
    // 每个 chunk 应有有效内容
    for (const chunk of chunks) {
      expect(chunk.displayCode.trim().length).toBeGreaterThan(0);
      expect(chunk.metadata.language).toBe('kotlin');
    }
  });

  it('contextPath breadcrumb contains class/function names', async () => {
    const parser = await getParser('kotlin');
    const tree = parser!.parse(kotlinSrc);
    const splitter = new SemanticSplitter({ maxChunkSize: 100 });
    const chunks = splitter.split(tree, kotlinSrc, 'MainActivity.kt', 'kotlin');

    const paths = chunks.map(c => c.metadata.contextPath.join(' > '));
    // 应存在包含 'MainActivity' 字样的 contextPath
    const hasClass = paths.some(p => p.includes('MainActivity'));
    expect(hasClass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. language.ts — .kts 识别
// ─────────────────────────────────────────────────────────────────────────────
describe('language.ts - .kts support', () => {
  it('maps .kts to kotlin', () => {
    expect(getLanguage('build.gradle.kts')).toBe('kotlin');
    expect(getLanguage('settings.gradle.kts')).toBe('kotlin');
    expect(getLanguage('app/build.gradle.kts')).toBe('kotlin');
  });

  it('still maps .kt to kotlin', () => {
    expect(getLanguage('MainActivity.kt')).toBe('kotlin');
  });

  it('.kts is in allowed extensions whitelist', () => {
    expect(isAllowedExtension('build.gradle.kts')).toBe(true);
  });
});
