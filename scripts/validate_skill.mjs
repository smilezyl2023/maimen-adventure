#!/usr/bin/env node
/**
 * 麦门大冒险 · 项目自检 validate_skill.mjs
 * 校验参赛必需的规范与红线，避免低级失误导致报名失败。
 *
 * 运行：node scripts/validate_skill.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const pass = [];

const REQUIRED_FILES = [
  'README.md',
  'CONTEST_DECLARATION.md',
  'MCP_INTEGRATION.md',
  'mcp-config.example.json',
  'SKILL.md',
];
const RECOMMENDED = ['workbuddy.md', 'assets/demo.html', 'assets/sample-menu.json', 'assets/banner.svg', 'scripts/test_engine.mjs'];

/* 1. 必需文件 */
for (const f of REQUIRED_FILES) {
  if (existsSync(join(ROOT, f))) pass.push(`必需文件存在: ${f}`);
  else errors.push(`缺少必需文件: ${f}`);
}
for (const f of RECOMMENDED) {
  if (!existsSync(join(ROOT, f))) warnings.push(`建议补充: ${f}`);
}

/* 2. SKILL.md frontmatter */
const skillPath = join(ROOT, 'SKILL.md');
if (existsSync(skillPath)) {
  const md = readFileSync(skillPath, 'utf8');
  if (!md.startsWith('---')) errors.push('SKILL.md 缺少 YAML frontmatter');
  const fm = md.split('---')[1] ?? '';
  if (!/^name:\s*\S+/m.test(fm)) errors.push('frontmatter 缺少 name');
  if (!/^description:\s*\S+/m.test(fm)) errors.push('frontmatter 缺少 description');
  const desc = (fm.match(/^description:\s*([\s\S]*?)$/m) ?? [])[1] ?? '';
  const triggers = ['麦门', '麦当劳', '点餐', '冒险'];
  const missing = triggers.filter((t) => !desc.includes(t));
  if (missing.length) warnings.push(`description 建议包含触发词: ${missing.join('、')}`);
  const lineCount = md.split('\n').length;
  if (lineCount > 220) warnings.push(`SKILL.md 有 ${lineCount} 行，建议压缩到 200 行内（明细移入 references/）`);
  else pass.push(`SKILL.md 行数合理: ${lineCount}`);
}

/* 3. 安全：不得包含真实 Token */
const TOKEN_PATTERNS = [
  /Bearer\s+(?!\$\{)[A-Za-z0-9\-_.]{20,}/, // Bearer 后跟真实 token
  /(?:api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9\-_.]{16,}["']/i,
];
const scanDirs = ['', 'scripts', 'assets', 'references'];
const suspicious = [];
for (const d of scanDirs) {
  const dir = join(ROOT, d);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    if (!/\.(md|json|mjs|js|html|txt|yml|yaml)$/i.test(f)) continue;
    if (f === 'validate_skill.mjs') continue;
    const text = readFileSync(p, 'utf8');
    for (const re of TOKEN_PATTERNS) {
      if (re.test(text)) suspicious.push(`${d ? d + '/' : ''}${f}`);
    }
  }
}
if (suspicious.length) errors.push(`疑似包含真实凭证，请改用环境变量占位符: ${suspicious.join(', ')}`);
else pass.push('未检测到真实 Token / 密钥');

/* 4. mcp-config.example.json 只允许占位符 */
const cfgPath = join(ROOT, 'mcp-config.example.json');
if (existsSync(cfgPath)) {
  const raw = readFileSync(cfgPath, 'utf8');
  try {
    const cfg = JSON.parse(raw.replace(/\$\{[^}]+\}/g, 'PLACEHOLDER'));
    const auth = cfg?.mcpServers?.['mcd-mcp']?.headers?.Authorization ?? '';
    if (!/PLACEHOLDER/.test(auth)) errors.push('mcp-config.example.json 的 Authorization 必须是环境变量占位符');
    else pass.push('mcp-config.example.json 使用占位符');
    if (cfg?.mcpServers?.['mcd-mcp']?.url !== 'https://mcp.mcd.cn') warnings.push('MCP url 建议为 https://mcp.mcd.cn');
  } catch (e) {
    errors.push(`mcp-config.example.json 不是合法 JSON: ${e.message}`);
  }
}

/* 5. CONTEST_DECLARATION.md 完整性（关键小节） */
const declPath = join(ROOT, 'CONTEST_DECLARATION.md');
if (existsSync(declPath)) {
  const decl = readFileSync(declPath, 'utf8');
  const sections = ['原创性声明', '合规声明', '信息安全声明', '规则遵守声明'];
  const missing = sections.filter((s) => !decl.includes(s));
  if (missing.length) errors.push(`CONTEST_DECLARATION.md 疑似被修改，缺少: ${missing.join('、')}`);
  else pass.push('CONTEST_DECLARATION.md 结构完整（需与官方原文逐字一致）');
}

/* 6. 合规红线文案扫描（README / SKILL / references / demo）
 * 注意：规则本身会出现在"禁用清单"里，因此需排除引用上下文的误报。
 */
const BANNED = [
  { re: /肯德基|KFC|汉堡王|德克士|华莱士/, msg: '出现其他餐饮品牌（规则禁止对比）' },
  { re: /(越吃越健康|零负担|放心吃不会胖|吃不胖)(?!.*禁用|.*❌|.*禁止)/, msg: '出现健康/医疗功效暗示' },
  { re: /(囤券|多囤)(?!.*禁用|.*❌|.*禁止)/, msg: '出现鼓励囤积浪费的表达' },
];

/** 判断某行是否为"禁用清单/反例/自查表"的说明行，这类行不参与违规判定 */
function isRuleContext(line) {
  // 显式的禁用/反例说明
  if (/禁用|禁止|❌|不要|避免|红线|反例|不给|不许|不推荐/.test(line)) return true;
  // 合规自查表格行：「| 红线项 | ✅ 无「xxx」类表达 |」——是陈述"已避免"，非违规
  if (/^\s*\|/.test(line) && /(✅|已避免|无「|无人)/.test(line)) return true;
  // 引号内被引用的禁用词本身（如 无「越吃越健康」）不做判定，交给下面剔除
  return false;
}

/** 剔除被引号包裹的"被引用词"，避免「无『囤券』类表达」被判违规 */
function stripQuoted(line) {
  return line.replace(/[「『“"'][^」』”"']*[」』”"']/g, '');
}

const textFiles = [];
for (const d of ['', 'references', 'assets']) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile() && /\.(md|html)$/i.test(f)) textFiles.push(p);
  }
}
for (const p of textFiles) {
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isRuleContext(line)) return;
    const probe = stripQuoted(line);
    for (const b of BANNED) {
      if (b.re.test(probe)) warnings.push(`${p.replace(ROOT + '/', '')}:${i + 1} ${b.msg}`);
    }
  });
}

/* 7. Star 诱导检测（只检查是否存在"给 Star 换好处"的正向话术） */
for (const p of textFiles) {
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isRuleContext(line)) return;
    const probe = stripQuoted(line);
    if (/star/i.test(probe) && /(换|送|奖励|返现|抽奖)/i.test(probe)) {
      warnings.push(`${p.replace(ROOT + '/', '')}:${i + 1} 出现 Star 诱导话术（属刷榜）`);
    }
  });
}
pass.push(`已扫描 ${textFiles.length} 个文案文件`);

/* Demo 引擎同步校验：
 * Demo 的引擎是由 sync_demo.mjs 从 build_pool.mjs 注入的。如果不同步，
 * 用户在网页里看到的菜单和命令行跑出来的不一样——这种 bug 最难发现，
 * 因为两边单独看都对。放进自检里，提交前就能拦住。 */
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/sync_demo.mjs'), '--check'], { stdio: 'pipe' });
  pass.push('Demo 引擎与 build_pool.mjs 同步');
} catch {
  errors.push('Demo 引擎与 build_pool.mjs 不同步 —— 运行 node scripts/sync_demo.mjs');
}

/* 输出 */
const line = (s) => console.log(s);
line('\n=== 麦门大冒险 · 项目自检 ===\n');
for (const p of pass) line(`  ✅ ${p}`);
for (const w of warnings) line(`  ⚠️  ${w}`);
for (const e of errors) line(`  ❌ ${e}`);
line('');
if (errors.length) {
  line(`结果：${errors.length} 个错误，${warnings.length} 个警告 —— 请先修复错误再报名\n`);
  process.exit(1);
}
line(`结果：通过（${warnings.length} 个警告）\n`);
