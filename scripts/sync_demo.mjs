#!/usr/bin/env node
/**
 * 麦门大冒险 · 把引擎同步进 Demo sync_demo.mjs
 * ------------------------------------------------------------
 * 为什么需要这个脚本：
 *   Demo 是单文件 HTML，必须能双击打开（file://）。而 file:// 下
 *   `<script type="module">` 无法 import 本地 .mjs（CORS 拦截），
 *   所以引擎只能内联。但"内联"不等于"抄一份"——手工抄过两次，
 *   两次都在一周内分叉了（isCombo 识别、配餐保底、二件套生成、
 *   排序档位、终局校正、候选组排除，六处漏同步），Demo 和 CLI
 *   给出不同的菜单，这比不做 Demo 更糟。
 *
 * 做法：
 *   从 scripts/build_pool.mjs 里截取引擎段（第 3~5 节，纯函数、零 Node 依赖），
 *   转成浏览器可执行的形式，写进 assets/demo.html 的标记区间。
 *   于是引擎只有一份源码，Demo 永远跟 CLI 同源。
 *
 * 运行：node scripts/sync_demo.mjs [--check]
 *   --check  只校验是否同步，不写文件（用于 CI / 提交前自检）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_PATH = resolve(ROOT, 'scripts/build_pool.mjs');
const DEMO_PATH = resolve(ROOT, 'assets/demo.html');

const BEGIN = '/* === ENGINE:BEGIN 由 scripts/sync_demo.mjs 生成，请勿手改 === */';
const END = '/* === ENGINE:END === */';

/** 从 build_pool.mjs 抽取"纯浏览器可跑"的引擎段 */
function extractEngine() {
  const src = readFileSync(ENGINE_PATH, 'utf8');
  const lines = src.split('\n');

  const startIdx = lines.findIndex((l) => l.includes('const BUCKET_KEYWORDS'));

  // 引擎终点 = 最后一个"7. CLI"段落标题所在行（前面是分隔注释）
  const cliIdx = lines.findIndex((l) => l.trim() === '* 6. CLI');
  if (startIdx < 0 || cliIdx < 0) throw new Error('抽不到引擎段，build_pool.mjs 的结构可能变了');

  // 从 cliIdx 往上找到那组 /* ==== 分隔线的开头
  let endIdx = cliIdx;
  while (endIdx > startIdx && !lines[endIdx].startsWith('/* ====')) endIdx -= 1;

  let body = lines.slice(startIdx, endIdx).join('\n');

  // 去掉 export 关键字（浏览器里用 IIFE 暴露，不需要 ESM 导出）
  body = body.replace(/^export function /gm, 'function ').replace(/^export const /gm, 'const ');

  return body.trim();
}

/** 生成内联脚本：IIFE + 暴露到 window.MaiMenEngine */
function buildBlock(engineBody) {
  const indented = engineBody
    .split('\n')
    .map((l) => (l.trim() ? '  ' + l : ''))
    .join('\n');

  return `${BEGIN}
(function () {
  "use strict";

${indented}

  /* 对外暴露：Demo 只认这 4 个入口，其余都是内部实现 */
  window.MaiMenEngine = { normalizeMenu, buildMenu, detectBucket, scoreItem, THEMES };
})();
${END}`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const engineBody = extractEngine();
  const block = buildBlock(engineBody);
  const html = readFileSync(DEMO_PATH, 'utf8');

  const b = html.indexOf(BEGIN);
  const e = html.indexOf(END);
  if (b < 0 || e < 0) throw new Error('demo.html 里找不到 ENGINE 标记区间');

  const next = html.slice(0, b) + block + html.slice(e + END.length);

  if (next === html) {
    console.log('  ✅ Demo 引擎已是最新');
    return;
  }
  if (checkOnly) {
    console.error('  ❌ Demo 引擎与 build_pool.mjs 不同步，请运行 node scripts/sync_demo.mjs');
    process.exit(1);
  }
  writeFileSync(DEMO_PATH, next, 'utf8');
  const lineCount = engineBody.split('\n').length;
  console.log(`  ✅ 已把 ${lineCount} 行引擎注入 assets/demo.html`);
}

main();
