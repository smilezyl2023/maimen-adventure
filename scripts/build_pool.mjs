#!/usr/bin/env node
/**
 * 麦门大冒险 · 组餐引擎 build_pool.mjs
 * ------------------------------------------------------------
 * 纯函数、零依赖。把 query-meals 返回的原始菜单，按用户 6 个问题的答案，
 * 本地过滤 + 打分 + 组合出 3 个主题互斥的「今日菜单」。
 *
 * 设计铁律：
 *   1. 不虚构菜品 —— 所有输出项必须能在传入的菜单里找到对应 code
 *   2. 不做 MCP 请求 —— 全程纯本地计算（菜单只取一次）
 *   3. 与 references/scoring-rules.md 严格对应
 *
 * 用法：
 *   node scripts/build_pool.mjs --menu assets/sample-menu.json --answers '{"budget":30,...}'
 *   node scripts/build_pool.mjs --demo          # 用内置示例答案跑一遍
 *
 * 作为模块：
 *   import { buildMenu, normalizeMenu, recommend } from './build_pool.mjs'
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 1. 菜单归一化：把 MCP 原始返回压成统一结构
 * ============================================================ */

const BUCKET_KEYWORDS = {
  mainFood: ['汉堡', '堡', '卷', '饭', '鸡排', '麦辣', '巨无霸', '安格斯', '奥良', '板烧', '双层', '吉士', '双层吉士'],
  side: ['薯条', '鸡块', '鸡翅', '小食', '麦乐鸡', '玉米', '沙拉', '派'],
  drink: ['可乐', '雪碧', '咖啡', '茶', '果汁', '奶茶', '矿泉水', '饮料', '美式', '拿铁'],
  dessert: ['冰淇淋', '甜筒', '圣代', '麦旋风', '蛋糕', '甜品', '新地'],
};

/** 价格可能是元或分，>1000 视为分 */
function normalizePrice(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n > 1000 ? +(n / 100).toFixed(2) : +n.toFixed(2);
}

/** 售罄判断，兼容多种字段 */
function isSoldOut(item) {
  if (item.soldOut === true || item.available === false) return true;
  const s = String(item.status ?? '').toUpperCase();
  return s === 'SOLD_OUT' || s === 'SOLD' || s === 'OFF_SHELF';
}

/** 按 category 优先、关键词兜底，判断餐品属于哪个桶 */
export function detectBucket(item) {
  const cat = String(item.category ?? item.categoryName ?? '').toLowerCase();
  const name = String(item.name ?? '');
  const combined = `${cat} ${name}`;

  // category 首选：命中英文/拼音分类
  const catMap = [
    [['dessert', 'sweet', '甜品', '冰淇淋'], 'dessert'],
    [['drink', 'beverage', '饮料', '饮品'], 'drink'],
    [['side', 'snack', '小食', '配餐'], 'side'],
    [['burger', 'main', '主食', '汉堡'], 'mainFood'],
  ];
  for (const [keys, bucket] of catMap) {
    if (keys.some((k) => cat.includes(k))) return bucket;
  }

  // 关键词兜底：先判甜品（因为它常出现在 side 分类里），再判其他
  for (const bucket of ['dessert', 'drink', 'side', 'mainFood']) {
    if (BUCKET_KEYWORDS[bucket].some((k) => combined.includes(k))) return bucket;
  }
  return null; // 无法归类 → 丢弃，不瞎猜
}

/** 把 MCP 原始菜单展开成扁平数组 */
function flattenMenu(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  // 兼容 { categories: [{ items: [] }] } / { data: [...] } / { meals: [...] }
  const candidates = ['items', 'meals', 'products', 'list', 'data', 'categories'];
  for (const key of candidates) {
    const v = raw[key];
    if (Array.isArray(v)) {
      // categories 还需要再拍平一层
      const out = [];
      for (const c of v) {
        if (Array.isArray(c.items)) out.push(...c.items.map((i) => ({ category: c.name ?? c.category, ...i })));
        else out.push(c);
      }
      return out;
    }
  }
  return [];
}

export function normalizeMenu(raw) {
  const items = flattenMenu(raw)
    .map((i, idx) => {
      const bucket = detectBucket(i);
      if (!bucket) return null;
      const name = String(i.name ?? i.mealName ?? '').trim();
      if (!name) return null;
      const tags = []
        .concat(i.tags ?? [])
        .concat(i.tag ?? [])
        .map((t) => (typeof t === 'string' ? t : t?.name ?? ''))
        .filter(Boolean);
      return {
        code: String(i.code ?? i.mealCode ?? i.id ?? `idx-${idx}`),
        name,
        bucket,
        price: normalizePrice(i.price ?? i.unitPrice ?? i.salePrice ?? i.originPrice),
        tags,
        kcal: i.kcal ?? i.energy ?? i.calorie ?? null,
        isCombo: Boolean(i.isCombo ?? i.combo ?? /套餐/.test(name)),
        soldOut: isSoldOut(i),
        raw: i,
      };
    })
    .filter(Boolean);

  const buckets = { mainFood: [], side: [], drink: [], dessert: [] };
  for (const it of items) {
    if (it.soldOut) continue;
    buckets[it.bucket].push(it);
  }
  return { items, buckets };
}

/* ============================================================
 * 2. 特征打标：辣度 / 风味 / 份量 / 健康 / 新品
 * ============================================================ */

const SPICY = ['辣', '香辣', '麻辣', '劲辣'];
const FLAVOR_MAP = {
  beef: ['牛', '巨无霸', '安格斯', '吉士', '双层'],
  chicken: ['鸡', '麦辣', '板烧', '奥良', '鸡排'],
  fish: ['鱼', '鳕'],
  veggie: ['素', '蔬菜', '沙拉', '玉米'],
};
const LARGE = ['大份', '双层', '巨无霸', '安格斯', '加大', '超大'];
const MEDIUM = ['中份', '正常份', '标准'];
const SMALL = ['小份', '迷你', '小食'];
const HEALTHY = ['沙拉', '蔬菜', '玉米', '无糖', '矿泉', '美式', '纯茶', '低脂', '鸡胸'];
const NOVEL = ['新品', '限定', '当季', 'NEW', '新品'];

function hasAny(text, keys) {
  return keys.some((k) => text.includes(k));
}

function tagsText(item) {
  return `${item.name} ${item.tags.join(' ')}`;
}

function isSpicy(item) {
  return hasAny(tagsText(item), SPICY);
}

function flavorOf(item) {
  const merged = tagsText(item);
  const hits = Object.entries(FLAVOR_MAP).filter(([, keys]) => hasAny(merged, keys));
  return hits.length ? hits.map(([f]) => f) : [];
}

/**
 * 份量推断：先看 tags 显式标注，再用热量做兜底。
 * 真实门店数据里 tags 常常是空的，只看 tags 会让"大小份"全变 normal，
 * 豪爽型就失去了"吃个痛快"的判断依据。热量阈值按主食量级校准。
 */
function sizeOf(item) {
  const t = tagsText(item);
  if (hasAny(t, LARGE)) return 'large';
  if (hasAny(t, SMALL)) return 'small';
  if (hasAny(t, MEDIUM)) return 'normal';
  const kcal = typeof item.kcal === 'number' ? item.kcal : 0;
  const isMain = item.bucket === 'mainFood';
  const hi = isMain ? 520 : 380;
  const lo = isMain ? 320 : 200;
  if (kcal >= hi) return 'large';
  if (kcal > 0 && kcal <= lo) return 'small';
  return 'normal';
}

/** 主食绝对热量（拍脑袋的量级校准，只用于主题人格，不参与营养结论） */
function mainKcalTier(item) {
  const kcal = typeof item.kcal === 'number' ? item.kcal : 0;
  if (!kcal) return 0;
  if (kcal >= 620) return 3; // 重磅
  if (kcal >= 500) return 2; // 扎实
  return 1;
}

/** 配料丰富度：双层/厚牛/巨无霸/安格斯这类"堆料"的，用名字信号兜底 */
function richnessOf(item) {
  const t = tagsText(item);
  let s = 0;
  if (/双层|巨无霸|厚牛|安格斯|三层|加大/.test(t)) s += 2;
  if (/牛|培根|芝士|吉士/.test(t)) s += 1;
  return s; // 0~3
}

function isHealthy(item) {
  return hasAny(tagsText(item), HEALTHY);
}

function isNovel(item) {
  return hasAny(tagsText(item), NOVEL);
}

/* ============================================================
 * 3. 单品打分（满分 100）
 * ============================================================ */

export function scoreItem(item, ans, ctx = {}) {
  const { budget = 30, flavor = 'any', spice = 'none', hunger = 'normal', careCalories = false } = ans;
  const minKcal = ctx.minKcal ?? null;

  // budgetFit 0~25
  let budgetFit;
  if (!Number.isFinite(budget)) budgetFit = 25;
  else if (item.price <= budget) budgetFit = 12.5 + 12.5 * (1 - item.price / (budget * 2));
  else if (item.price <= budget * 1.2) budgetFit = 10;
  else budgetFit = 0;

  // flavorFit 0~25
  let flavorFit = 5;
  if (flavor === 'any') flavorFit = 20;
  else if (flavorOf(item).includes(flavor)) flavorFit = 25;

  // spiceFit 0~15
  const spicy = isSpicy(item);
  let spiceFit;
  if (spice === 'none') spiceFit = spicy ? 0 : 15;
  else if (spice === 'mild') spiceFit = spicy ? 12 : 10;
  else spiceFit = spicy ? 15 : 6;

  // fullnessFit 0~15
  const size = sizeOf(item);
  let fullnessFit = 15;
  if (hunger === 'light') fullnessFit = size === 'small' || size === 'normal' ? 15 : 6;
  else if (hunger === 'heavy') fullnessFit = size === 'large' ? 15 : size === 'normal' ? 10 : 5;

  // healthFit 0~10
  let healthFit = 5;
  if (careCalories) {
    if (item.kcal && minKcal) {
      const ratio = minKcal / item.kcal; // 越小越健康
      healthFit = Math.max(0, Math.min(10, 10 * ratio));
    } else if (isHealthy(item)) healthFit = 9;
    else healthFit = 4;
  }

  // novelty 0~10
  const novelty = isNovel(item) ? 10 : 5;

  const total = budgetFit + flavorFit + spiceFit + fullnessFit + healthFit + novelty;
  return {
    total: +total.toFixed(2),
    detail: {
      budgetFit: +budgetFit.toFixed(2),
      flavorFit,
      spiceFit,
      fullnessFit,
      healthFit: +healthFit.toFixed(2),
      novelty,
    },
  };
}

/* ============================================================
 * 4. 三主题目标函数
 * ============================================================ */

const THEMES = [
  { key: 'hearty', label: '🗡️ 豪爽型', desc: '来都来了，吃个痛快' },
  { key: 'fresh', label: '🌿 清爽型', desc: '想吃，但不想有负担' },
  { key: 'value', label: '💰 性价比型', desc: '每一分钱都要花在刀刃上' },
];

function themeScore(item, theme, ans, ctx) {
  const base = scoreItem(item, ans, ctx);
  const d = base.detail;
  const priceRatio = 1 - item.price / (ctx.maxPrice || Math.max(item.price, 1)); // 0~1，越便宜越高

  // 用户偏好（风味/辣度/预算）已构成基础分主体；主题在此基础上做"人格化"差异
  const isMain = item.bucket === 'mainFood';
  const size = sizeOf(item);
  const kcal = item.kcal ?? 0;

  if (theme === 'hearty') {
    // 豪爽：吃得痛快 —— 只看"够不够猛"，不看用户风味偏好（风味已由候选池硬过滤保证）
    // 三个信号叠加：份量档位 + 绝对热量 + 堆料程度，避免被 budgetFit 的 ±1 分波动盖过
    const bigBoost = size === 'large' ? 34 : size === 'small' ? -30 : 0;
    const kcalBoost = kcal ? Math.min(26, kcal / 26) : 0;
    const richBoost = isMain ? richnessOf(item) * 4 : 0;
    const s = 0.3 * d.budgetFit + bigBoost + kcalBoost + richBoost;
    return { score: +s.toFixed(2), base };
  }
  if (theme === 'fresh') {
    // 清爽：轻负担优先 —— 辣/油炸/高热量扣分必须压过风味匹配（清爽型不推荐辣堡）
    // 水果/蔬菜/无糖类给正向加成，让"清爽"有正向人格而不只是减分
    const friedPenalty = hasAny(tagsText(item), ['薯条', '炸', '鸡块', '鸡翅', '麦辣']) ? 30 : 0;
    const spicyPenalty = isSpicy(item) ? 22 : 0;
    const kcalPenalty = kcal ? Math.min(28, kcal / 30) : 10;
    const healthyBoost = isHealthy(item) ? 22 : 0;
    const s = 0.3 * d.budgetFit + healthyBoost - friedPenalty - spicyPenalty - kcalPenalty;
    return { score: +s.toFixed(2), base };
  }
  // 性价比：钱要花得值 —— 便宜是入场券，"同样价钱给得更多"才是性价比的真义
  const valueRatio = (kcal && item.price > 0) ? Math.min(3, kcal / item.price) : 0;
  const s = 0.45 * d.budgetFit + priceRatio * 22 + valueRatio * 9;
  return { score: +s.toFixed(2), base };
}

/** 硬约束过滤：超预算 20% 直接淘汰（宽松模式除外） */
function hardFilter(items, ans) {
  const budget = ans.budget;
  if (!Number.isFinite(budget)) return items;
  return items.filter((i) => i.price <= budget * 1.2);
}

/**
 * 用户偏好硬过滤（优先级最高：用户诉求 > 主题人格）
 * - 不吃辣 → 剔除全部辣味餐品（若剔除后为空则保留）
 * - 指定风味 → 仅约束主食桶（小食/饮料/甜品不受风味约束）
 * 注：无对应风味时自动回退到放宽，保证永远有候选。
 */
function applyUserPreference(items, ans) {
  let out = items;

  if (ans.spice === 'none') {
    const nonSpicy = out.filter((i) => !isSpicy(i));
    if (nonSpicy.length) out = nonSpicy;
  }

  if (ans.flavor && ans.flavor !== 'any') {
    const mainOnly = out.filter((i) => i.bucket === 'mainFood');
    if (mainOnly.length) {
      const flavoredCodes = new Set(mainOnly.filter((i) => flavorOf(i).includes(ans.flavor)).map((i) => i.code));
      if (flavoredCodes.size) out = out.filter((i) => i.bucket !== 'mainFood' || flavoredCodes.has(i.code));
    }
  }
  return out;
}

/**
 * 候选准备：用户偏好是硬约束，预算不在桶层淘汰候选。
 * 预算约束统一放到"组合层"（总价 ≤ 人均预算 × 人数 × 1.1）执行。
 * 刻意不回退到全量桶——否则用户说了"不辣"却收到辣堡，等于偏好失效。
 */
function fillBucket(bucket, ans) {
  return applyUserPreference(bucket, ans);
}

/* ============================================================
 * 5. 组合生成
 * ============================================================ */

function qtyFor(bucketName, ans) {
  const people = Math.max(1, ans.people ?? 1);
  if (bucketName === 'mainFood') {
    // 人均 1 份；"很饿"时每人 +0.5 份向上取整（1人→2，2人→3，4人→4）
    return ans.hunger === 'heavy' ? Math.ceil(people * 1.5) : people;
  }
  if (bucketName === 'side') return people;
  if (bucketName === 'drink') return ans.wantDrink === false ? 0 : people;
  if (bucketName === 'dessert') return ans.wantDessert === false ? 0 : people;
  return people;
}

function pickTop(items, theme, ans, ctx, n = 3) {
  return items
    .map((i) => ({ item: i, score: themeScore(i, theme, ans, ctx).score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

function comboScore(combo, ans) {
  const sum = combo.reduce((acc, c) => acc + c.score, 0) / combo.length;
  const bucketsCovered = new Set(combo.map((c) => c.item.bucket)).size;
  // 完整度加成：三件套(主食+配餐+饮料)最像"一顿完整的饭"，最多 +8
  const diversityBonus = (bucketsCovered - 1) * 4;
  // 预算占满率：在预算内花得更值略加分，避免永远选最便宜的凑数组合
  const total = combo.reduce((acc, c) => acc + c.item.price * c.qty, 0);
  const cap = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : Infinity;
  const fillRatio = Number.isFinite(cap) && cap > 0 ? Math.min(1, total / cap) : 0.6;
  return +(sum + diversityBonus + fillRatio * 4).toFixed(2);
}

function cartesian(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

export function buildMenu(menu, ans) {
  const norm = menu && menu.buckets ? menu : normalizeMenu(menu);
  const b = norm.buckets;

  // 容错：允许调用方直接传 question-mapping.md 里的原始字段名（budgetPerPerson）
  const a = { ...ans };
  if (!Number.isFinite(a.budget) && Number.isFinite(a.budgetPerPerson)) {
    a.budget = a.budgetPerPerson;
  }
  ans = a;

  const kcalList = norm.items.filter((i) => i.kcal).map((i) => i.kcal);
  const ctx = {
    minKcal: kcalList.length ? Math.min(...kcalList) : null,
    careCalories: ans.careCalories,
  };

  const maxPrice = Math.max(...norm.items.map((i) => i.price), 1);

  // 每个桶准备候选（含空桶保护）
  const prepared = {
    mainFood: fillBucket(b.mainFood, ans, ctx),
    side: fillBucket(b.side, ans, ctx),
    drink: fillBucket(b.drink, ans, ctx),
    dessert: fillBucket(b.dessert, ans, ctx),
  };

  const results = [];
  const usedMain = new Set();
  const usedSignatures = new Set();
  const cap = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) * 1.1 : Infinity;
  const totalOf = (c) => c.combo.reduce((acc, x) => acc + x.item.price * x.qty, 0);

  // 每个主题独立的主食排序（套餐优先）
  const rankedMains = {};
  for (const theme of THEMES) {
    const mains = prepared.mainFood;
    const comboMains = mains.filter((i) => i.isCombo);
    let pool = comboMains.length && theme.key !== 'fresh' ? comboMains : mains;
    if (!pool.length) pool = mains;
    // 清爽型的"人格底线"，按优先级逐层收紧（每层都做"非空才采纳"，绝不清空食物池）：
    //   1. 主食不辣         —— 辣堡直接违背"清爽"人设
    //   2. 非油炸/非高热量   —— 炸鸡类剔除
    //   3. 同类里热量更低    —— 只保留热量不超过中位数的
    if (theme.key === 'fresh') {
      const nonSpicy = pool.filter((i) => !isSpicy(i));
      if (nonSpicy.length) pool = nonSpicy;

      const notFried = pool.filter((i) => !hasAny(tagsText(i), ['薯条', '炸', '鸡块', '鸡翅', '麦辣']));
      if (notFried.length) pool = notFried;

      const withKcal = pool.filter((i) => typeof i.kcal === 'number' && i.kcal > 0);
      if (withKcal.length >= 2) {
        const sorted = withKcal.map((i) => i.kcal).sort((x, y) => x - y);
        const median = sorted[Math.floor(sorted.length / 2)];
        const lighter = pool.filter((i) => !(typeof i.kcal === 'number' && i.kcal > median));
        if (lighter.length) pool = lighter;
      }
    }
    rankedMains[theme.key] = pickTop(pool, theme.key, ans, { ...ctx, maxPrice }, 99);
  }

  for (const theme of THEMES) {
    const ctxTheme = { ...ctx, maxPrice };
    const people = Math.max(1, ans.people ?? 1);

    // 主食候选：优先"未被其它主题用过"的，但只在"不影响预算合规"的前提下。
    // 关键原则：预算合规 > 三卡差异化。若去掉已用主食会导致本主题无合规组合，
    // 就保留全部候选（宁可两张卡主食相同，也不能给出超预算的菜单）。
    const ranked = rankedMains[theme.key] ?? [];
    const unused = ranked.filter((m) => !usedMain.has(m.item.code));
    const mainCandidates = (unused.length ? unused : ranked).slice(0, 5);
    // 若"去重后的候选"凑不出预算内组合，则回退到完整候选池
    if (!mainCandidates.length) continue;

    // 配餐桶：为控制组合数，每桶保留"主题 Top3 + 最便宜 3 个"。
    // 曾经只留 2 个，结果豪爽型的配餐永远是苹果派+矿泉水（最便宜那两个被"低价兜底"选票挤满），
    // 三张卡的主食又都被预算压成同一款，最后三张卡长得一模一样。放宽到 3 后才有真实分化空间。
    const pickBucket = (bucketName) => {
      if (!prepared[bucketName].length) return [];
      if (qtyFor(bucketName, ans) === 0) return [];
      const scored = prepared[bucketName].map((i) => ({
        item: i,
        score: themeScore(i, theme.key, ans, ctxTheme).score,
      }));
      const byScore = scored.slice().sort((a, b) => b.score - a.score).slice(0, 3);
      const byPrice = scored.slice().sort((a, b) => a.item.price - b.item.price).slice(0, 3);
      const map = new Map();
      for (const s of [...byScore, ...byPrice]) map.set(s.item.code, s);
      return [...map.values()];
    };

    const sidePool = pickBucket('side');
    const drinkPool = pickBucket('drink');
    const dessertPool = pickBucket('dessert');

    // 降级用：只留各桶最便宜的一款。
    // 用途是"用户说要饮料，但预算根本放不下饮料"时，宁可给他主食+小食，
    // 也不要把预算全砸在饮料上、主食被迫降级成最便宜那款（那才是真的不划算）。
    const cheapestOf = (bucketName) => {
      if (!prepared[bucketName].length || qtyFor(bucketName, ans) === 0) return [];
      const item = prepared[bucketName].slice().sort((a, b) => a.price - b.price)[0];
      return [{ item, score: themeScore(item, theme.key, ans, ctxTheme).score }];
    };
    const sideLite = cheapestOf('side');
    const drinkLite = cheapestOf('drink');
    const dessertLite = cheapestOf('dessert');

    // 生成"围着某个主食"的组合：穷举各桶候选，天然保证多样性，再用预算硬筛选。
    // 预算紧时（主食吃掉 70% 以上额度）会自动生成"精简组合"（只留主食+一个配餐），
    // 否则用户说"要有饮料"却又只给 30 块时，会被迫把预算全砸在饮料上、主食变成最便宜的凑数款。
    const combosFor = (main) => {
      const mainPrice = main.item.price * qtyFor('mainFood', ans);
      const tight = Number.isFinite(cap) && mainPrice > cap * 0.7;

      const build = (slots) =>
        cartesian(slots).map((arr) => {
          const enriched = arr.map((c) => ({ ...c, qty: qtyFor(c.item.bucket, ans) }));
          const total = enriched.reduce((a, x) => a + x.item.price * x.qty, 0);
          const buckets = new Set(enriched.map((x) => x.item.bucket)).size;
          return { combo: enriched, total, buckets, score: comboScore(enriched, ans) };
        });

      const slots = [[main]];
      if (!main.item.isCombo && sidePool.length) slots.push(sidePool);
      if (drinkPool.length) slots.push(drinkPool);
      if (dessertPool.length) slots.push(dessertPool);

      const full = build(slots);
      if (!tight) return full;

      // 精简（预算紧时才生成，且优先级低于完整组合，只在完整组合全超预算时才生效）：
      //   3 件套（主食+小食+饮料）
      //   2 件套（主食 + 小食 / 饮料 / 甜品 任选其一）
      // 2 件套一律用"各桶最便宜的一款"，避免为了保饮料而让主食降级。
      const available = [];
      if (!main.item.isCombo) available.push(sidePool.length ? sidePool : sideLite);
      if (drinkPool.length) available.push(drinkPool);
      if (dessertPool.length) available.push(dessertPool);

      const threePiece = available.length >= 2
        ? build([[main], available[0], available[1]])
        : [];
      const twoPiece = [];
      if (!main.item.isCombo && sideLite.length) twoPiece.push(build([[main], sideLite]));
      if (drinkLite.length) twoPiece.push(build([[main], drinkLite]));
      if (dessertLite.length) twoPiece.push(build([[main], dessertLite]));

      return [...full, ...threePiece, ...twoPiece.flat()];
    };

    // 期望的桶数（用于衡量"组合完整度"）
    const expectedBuckets = 1 + (sidePool.length && !mainCandidates[0]?.item.isCombo ? 1 : 0) + (drinkPool.length ? 1 : 0) + (dessertPool.length ? 1 : 0);

    const allOptions = mainCandidates.flatMap((m) => combosFor(m).map((c) => ({ ...c, mainCode: m.item.code })));

    // 取舍规则（明确写死）：
    //   1. 硬约束：只在预算内组合里挑（人均预算 × 人数 × 1.1）
    //   2. 若"去重后的候选"凑不出合规组合 → 回退到完整主食池重新生成（预算合规优先于差异化）
    //   3. 全部超预算（预算极低）→ 取"离预算最近"的组合，不取"最便宜"的
    //      （把预算是让用户吃得像样用的，不是用来攒钱的）
    let candidatesForBudget = allOptions;
    if (!allOptions.some((c) => c.total <= cap)) {
      const fullPool = ranked.slice(0, 8);
      const fallback = fullPool.flatMap((m) => combosFor(m).map((c) => ({ ...c, mainCode: m.item.code })));
      if (fallback.some((c) => c.total <= cap)) candidatesForBudget = fallback;

      // 仍然没有任何组合进预算 → 此时"离谱的贵"比"便宜"更糟：
      // 预算 15 块绝不该蹦出一份 ¥62 的安格斯套餐。
      // 做法：按"主食单价"做二次截断，只保留全桶最便宜那一档主食参与的候选。
      const cheapestMain = ranked.reduce(
        (min, m) => (m.item.price < min ? m.item.price : min),
        Number.POSITIVE_INFINITY
      );
      const saneCeil = cheapestMain + Math.max(20, (Number.isFinite(ans.budget) ? ans.budget : 30) * 0.5);
      const sane = candidatesForBudget.filter((c) => c.combo[0].item.price <= saneCeil);
      if (sane.length) candidatesForBudget = sane;
    }

    const withinCap = candidatesForBudget.filter((c) => c.total <= cap);
    const overBudget = withinCap.length === 0;

    /* 预算紧时的取舍（这是本项目最容易出错的地方，规则写死在这里）：
     * 当"合规组合花钱太少"（< 预算的 75%），说明这个主题在现有预算下凑不出它该有的样子
     * —— 比如豪爽型只能买到一个脆鸡堡，却因为配了矿泉水而"合规"。
     * 此时允许轻微突破硬上限，但封顶在 预算 × 1.3，并且明确标记 stretch，
     * 由上层文案如实告知用户"稍微超了一点，可以去掉某样"，绝不悄悄超预算。
     */
    const softCap = Number.isFinite(cap) ? cap * (1.3 / 1.1) : Infinity;
    const baseline = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : 0;
    const spendFloor = baseline * 0.75;
    const topWithin = withinCap.slice().sort((a, b) => b.score - a.score)[0];
    const needStretch = !overBudget && topWithin && topWithin.total < spendFloor;

    let pool;
    if (overBudget) {
      pool = candidatesForBudget;
    } else if (needStretch) {
      const stretched = candidatesForBudget.filter((c) => c.total <= softCap);
      pool = stretched.length ? stretched : withinCap;
    } else {
      pool = withinCap;
    }

    const options = pool.sort((a, b) => {
      if (overBudget) {
        // 预算实在不够时：取"离预算最近"的，而不是最便宜那个。
        // 预算是为了让用户吃得像样，不是用来攒钱的。
        const baselineTotal = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : 0;
        return Math.abs(a.total - baselineTotal) - Math.abs(b.total - baselineTotal);
      }
      return b.score - a.score;
    });
    void expectedBuckets;
    void people;

    const signature = (c) => c.combo.map((x) => `${x.item.code}x${x.qty}`).sort().join('|');
    // 差异化策略（按优先级）：
    //   1. 优先"主食不同 且 整体清单不同" —— 最理想
    //   2. 次选"整体清单不同" —— 主食相同时靠配餐区分（真实菜单里主食可选往往有限）
    //   3. 兜底取本主题最优
    // 注意：以上都在"已按预算筛过"的候选里进行，保证不会为了差异化而超预算。
    // 差异化必须建立在"分数几乎一样"的候选之间（差价 ≤10 分）；
    // 如果为此要牺牲 >10 分，说明这个主题在这里没有第二个合理选择，宁可重复也不将就。
    const top = options[0];
    const nearTop = options.filter((c) => top && top.score - c.score <= 10);

    let chosen = top;
    const diffCandidate =
      nearTop.find((c) => !usedMain.has(c.combo[0].item.code) && !usedSignatures.has(signature(c))) ??
      nearTop.find((c) => !usedSignatures.has(signature(c)));
    if (diffCandidate) chosen = diffCandidate;

    // 诚实优先：如果"差异化选择"要超预算，而"最优选择"不超，就用不超的那个。
    // 因为用户对钱的敏感度远高于"三张卡长得不一样"。
    const userBudget = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : Infinity;
    const totalOfCombo = (c) => c.combo.reduce((acc, x) => acc + x.item.price * x.qty, 0);
    if (diffCandidate && top && totalOfCombo(diffCandidate) > userBudget && totalOfCombo(top) <= userBudget) {
      chosen = top;
    }

    if (!chosen) continue;
    usedMain.add(chosen.combo[0].item.code);
    usedSignatures.add(signature(chosen));

    const total = chosen.combo.reduce((acc, c) => acc + c.item.price * c.qty, 0);
    // 热量：只要有任一餐品有数据就求和已知部分，并标记完整性
    const withKcal = chosen.combo.filter((c) => typeof c.item.kcal === 'number');
    const totalKcal = withKcal.length
      ? withKcal.reduce((acc, c) => acc + c.item.kcal * c.qty, 0)
      : null;
    const kcalComplete = withKcal.length === chosen.combo.length;

    // 预算状态：三种，必须让用户一眼看清，不能让"¥33"这种数字自己说话。
    // 注意"超支"的基准是**用户报的预算**，不是系统内部放宽 10% 的上限——
    // 用户说 30 块，账单 32 块，那就得说"超了 2 块"，不能拿内部容差糊弄过去。
    const overCap = total > userBudget + 0.01;
    const overAmount = overCap ? +(total - userBudget).toFixed(2) : 0;
    const budgetStatus = overBudget ? 'overAll' : overCap ? 'stretch' : 'inBudget';

    results.push({
      theme: theme.key,
      label: theme.label,
      tagline: theme.desc,
      items: chosen.combo.map((c) => ({
        code: c.item.code,
        name: c.item.name,
        bucket: c.item.bucket,
        qty: c.qty,
        price: c.item.price,
        subtotal: +(c.item.price * c.qty).toFixed(2),
        kcal: c.item.kcal,
      })),
      estimateTotal: +total.toFixed(2),
      totalKcal,
      kcalComplete,
      overBudget,
      budgetCap: Number.isFinite(userBudget) ? +userBudget.toFixed(2) : null,
      budgetStatus,
      overAmount,
      note:
        budgetStatus === 'inBudget'
          ? '预算内'
          : budgetStatus === 'stretch'
            ? `略超预算 ¥${overAmount}`
            : `预算不够（超 ¥${overAmount}）`,
      score: chosen.score,
      reason: buildReason(theme.key, chosen.combo, ans),
    });
  }

  return {
    answers: ans,
    menuStats: {
      total: norm.items.length,
      buckets: Object.fromEntries(Object.entries(prepared).map(([k, v]) => [k, v.length])),
    },
    plans: results,
  };
}

function buildReason(theme, combo, ans) {
  const names = combo.map((c) => c.item.name);
  if (theme === 'hearty') return `${names[0]} 打头，配${names.slice(1).join('、') || '单点'}，饱腹感拉满；饿了就别客气。`;
  if (theme === 'fresh') return `${names[0]} 为主，搭配${names.slice(1).join('、') || '单点'}，整体口味更轻盈，吃完不犯困。`;
  return `${names.join(' + ')} 的组合单价最省，优惠后性价比最高；预算内吃得体面。`;
}

/* ============================================================
 * 6. CLI
 * ============================================================ */

function parseArgs(argv) {
  const out = { demo: false, card: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--demo') out.demo = true;
    else if (argv[i] === '--card') out.card = true;
    else if (argv[i] === '--menu') out.menu = argv[++i];
    else if (argv[i] === '--answers') out.answers = JSON.parse(argv[++i]);
  }
  return out;
}

const DEMO_ANSWERS = {
  budget: 30,
  hunger: 'normal',
  flavor: 'chicken',
  spice: 'mild',
  people: 1,
  wantDrink: true,
  wantDessert: false,
  careCalories: false,
};

function toCard(res) {
  const { plans, answers } = res;
  const userBudget = Number.isFinite(answers?.budget)
    ? answers.budget * Math.max(1, answers.people ?? 1)
    : null;

  return plans
    .map((p) => {
      const lines = p.items.map((i) => `  · ${i.name} ×${i.qty}  ¥${i.subtotal}`);
      const kcal = p.totalKcal ? `热量约 ${p.totalKcal} kcal（仅供参考）` : '热量数据暂缺';

      // 每张卡如实标注预算状态；超支不允许无声无息
      const badge =
        p.budgetStatus === 'inBudget'
          ? '预算内'
          : `⚠️ ${p.note}`;
      const priceLine =
        userBudget === null
          ? `  预估 ¥${p.estimateTotal.toFixed(2)} ｜ ${badge}`
          : `  预估 ¥${p.estimateTotal.toFixed(2)} / 预算 ¥${userBudget.toFixed(2)} ｜ ${badge}`;

      return [
        `${p.label} —— ${p.tagline}`,
        ...lines,
        '  ───────────────',
        `  ${kcal}`,
        priceLine,
        `  ${p.reason}`,
      ].join('\n');
    })
    .join('\n\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const menuPath = args.menu ?? resolve(__dirname, '../assets/sample-menu.json');
  const raw = JSON.parse(readFileSync(menuPath, 'utf8'));
  const ans = args.answers ?? DEMO_ANSWERS;
  const res = buildMenu(raw, ans);
  if (args.card) {
    console.log(toCard(res));
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
}

export { DEMO_ANSWERS, THEMES };
