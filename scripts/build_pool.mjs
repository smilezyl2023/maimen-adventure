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
  const cats = [].concat(item.categories ?? [], item.category ?? [], item.categoryName ?? []);
  const cat = cats.join(' ').toLowerCase();
  const name = String(item.name ?? '');
  const combined = `${cat} ${name}`;

  /* 0. 真实的"卖相"优先于分类名。
   *    实测踩过的坑：分类「巨无霸牛鱼肉堡」里有"那么大鸡排（椒盐风味）"，
   *    但它显然是小食不是主食；分类「小食拼盘」里还有一份 ¥62 的四人餐。
   *    先按明确的商品类型切，再退回分类。 */
  if (/酱$|蘸酱/.test(name)) return 'side';               // 蘸酱属于配餐附件
  if (/周边|贴|痒痒挠|玩具|玩偶|盲盒|卡片/.test(name)) return null; // 非食品，直接丢弃
  if (/冰淇淋|甜筒|圣代|麦旋风|新地|派$|蛋糕|拉明顿|阿芙佳朵/.test(name)) return 'dessert';
  if (/可乐|雪碧|咖啡|奶铁|美式|拿铁|卡布奇诺|奶茶|茶$|红茶|绿茶|汁|矿泉水|纯悦|牛奶|奶昔|雪冰|豆浆|燕麦奶|怡泉/.test(name)) return 'drink';
  if (/鸡排|鸡块|麦乐鸡|鸡翅|薯条|薯饼|玉米杯|沙拉|苹果片|鸡球|笋卷|油条/.test(name)) return 'side';

  // 分类首选：命中英文/拼音分类
  const catMap = [
    [['dessert', 'sweet', '甜品', '冰淇淋'], 'dessert'],
    [['drink', 'beverage', '饮料', '饮品'], 'drink'],
    [['side', 'snack', '小食', '配餐', '拼盘'], 'side'],
    [['burger', 'main', '主食', '汉堡', '堡'], 'mainFood'],
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
      // 套餐识别：显式字段 > 名称关键词 > 分类关键词。
      // 真实数据里"M 记套餐"不会带 isCombo 字段，只能靠名字/分类判断，
      // 判错的后果很严重——一个 ¥49 的三件套会再被配上薯条和可乐变成 ¥76。
      const catText = [].concat(i.categories ?? [], i.category ?? [], i.categoryName ?? []).join(' ');
      const comboByName = /三件套|套餐|开心乐园餐|双人餐|多人餐|任选|组合|精选|拼盘|桶/.test(name);
      const comboByCat = /套餐|多人餐|拼盘|组合/.test(catText);
      // 第三类：不是"套餐"，但也不是"一个具体汉堡"——「堡堡随心拼(7件任选)」「鸡肉堡单品精选」
      // 「牛肉堡单品精选」这类，是**任选/候选组**，价格与内容都不确定。
      // 若当成主食挑中，会输出"¥27 的鸡肉堡单品精选"这种连是哪只堡都答不上来的菜单，
      // 下单环节直接卡死。故一律标记为 notOrderable：不进主食候选。
      const groupBy = /任选|精选|随心拼|自选|组合装/.test(name);
      const isGroup = Boolean(i.isGroup) || groupBy;
      const isCombo = Boolean(i.isCombo ?? i.combo ?? (comboByName || comboByCat)) || isGroup;
      return {
        code: String(i.code ?? i.mealCode ?? i.id ?? `idx-${idx}`),
        name,
        bucket,
        price: normalizePrice(i.price ?? i.unitPrice ?? i.salePrice ?? i.originPrice),
        originalPrice: Number.isFinite(Number(i.originalPrice)) ? Number(i.originalPrice) : null,
        tags,
        kcal: i.kcal ?? i.energy ?? i.calorie ?? null,
        isCombo,
        isGroup,
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
    // 热量未知时按"中等偏重"处理（罚 14），不能当成 0 罚分——
    // 否则一个不知道热量的厚牛堡会被算成比 391 kcal 的板烧还"清爽"。
    const kcalPenalty = kcal ? Math.min(28, kcal / 30) : 14;
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

/**
 * 把"内部候选组合"转成对外的一张卡。
 * 主循环和终局校正都要用它，抽出来是为了避免两处各写一份、
 * 哪天改了字段但只改了一处（曾经 budgetStatus 就只在主循环里算过）。
 */
function makePlan(themeKey, chosen, ans) {
  const theme = THEMES.find((t) => t.key === themeKey) ?? { key: themeKey, label: themeKey, desc: '' };
  const total = chosen.combo.reduce((acc, c) => acc + c.item.price * c.qty, 0);
  const withKcal = chosen.combo.filter((c) => typeof c.item.kcal === 'number');
  const totalKcal = withKcal.length ? withKcal.reduce((acc, c) => acc + c.item.kcal * c.qty, 0) : null;
  const kcalComplete = withKcal.length === chosen.combo.length;

  const userBudget = Number.isFinite(ans?.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : Infinity;
  const overCap = total > userBudget + 0.01;
  const overAmount = overCap ? +(total - userBudget).toFixed(2) : 0;
  const overBudget = !Number.isFinite(userBudget);
  const budgetStatus = overCap ? 'stretch' : 'inBudget';

  return {
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
    note: budgetStatus === 'inBudget' ? '预算内' : `略超预算 ¥${overAmount}`,
    score: chosen.score,
    reason: buildReason(theme.key, chosen.combo, ans),
  };
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

  /* 热量基线：只用**主食桶**里有数据的项。
   * 曾经用「全菜单最低热量」，而最低的那条是锡兰红茶（2 kcal），
   * 结果所有主食的 healthFit 都被压成 0，清爽型只能靠"有没有低脂标签"瞎猜，
   * 甚至把热量未知的芝士堡当成"轻盈"推荐出去。 */
  const mainKcalList = norm.buckets.mainFood
    .map((i) => i.kcal)
    .filter((v) => typeof v === 'number' && v > 0);
  const ctx = {
    minKcal: mainKcalList.length ? Math.min(...mainKcalList) : null,
    careCalories: ans.careCalories,
  };

  const maxPrice = Math.max(...norm.items.map((i) => i.price), 1);

  // 每个桶准备候选（含空桶保护）
  /* 配餐桶里不该出现"套餐"。
   * 实测：小食分类下挂着「麦乐鸡套餐 ¥45」「麦辣鸡翅4块套餐 ¥59.5」，
   * 如果不剔除，会出现"一份主食 + 一份 ¥45 的配餐套餐"这种又贵又重复的组合。
   * 主食桶保留套餐（它本来就是"一整份饭"），配餐桶一律只留单点。 */
  const prepared = {
    // 「X 单品精选」「堡堡随心拼(7件任选)」这类"候选组"不进主食桶：
    // 它既不是一只具体的堡，也没法下单（用户还得再选一次），价格却像一份主食。
    // 实测被选成性价比卡后输出"¥27 的鸡肉堡单品精选"——说得跟没说一样。
    mainFood: fillBucket(b.mainFood, ans, ctx).filter((i) => !i.isGroup),
    side: fillBucket(b.side, ans, ctx).filter((i) => !i.isCombo),
    drink: fillBucket(b.drink, ans, ctx).filter((i) => !i.isCombo),
    dessert: fillBucket(b.dessert, ans, ctx).filter((i) => !i.isCombo),
  };

  const results = [];
  let valueCandidates = [];
  const themeCandidatePools = {};
  const usedMain = new Set();
  const usedSignatures = new Set();
  const cap = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) * 1.1 : Infinity;
  const totalOf = (c) => c.combo.reduce((acc, x) => acc + x.item.price * x.qty, 0);

  // 每个主题独立的主食排序（套餐优先）
  const rankedMains = {};
  for (const theme of THEMES) {
    const mains = prepared.mainFood;
    const comboMains = mains.filter((i) => i.isCombo);
    const singleMains = mains.filter((i) => !i.isCombo);

    // 套餐不能一律优先。
    // 真实数据里套餐动辄 ¥49-63，而单品堡只要 ¥15-39；如果直接"有套餐就用套餐"，
    // 性价比型会被逼着推荐全店最贵的东西（实测出现过"性价比 ¥59.9"这种笑话）。
    // 正确做法：套餐和单品放在同一个池子里比，交给主题函数去判断谁更合适。
    let pool = mains;
    if (theme.key === 'fresh' && singleMains.length) {
      // 清爽型优先单品（套餐里往往自带薯条可乐，与"清爽"人设相悖）
      pool = singleMains;
    }
    // 清爽型的"人格底线"，按优先级逐层收紧（每层都做"非空才采纳"，绝不清空食物池）：
    //   1. 主食不辣          —— 辣堡直接违背"清爽"人设
    //   2. 非油炸/非高热量    —— 炸鸡类剔除
    //   3. 有热量数据         —— 连热量都不知道的，没资格被打上"轻盈"标签
    //   4. 热量不超过中位数   —— 同类里只留更轻的那一半
    if (theme.key === 'fresh') {
      const nonSpicy = pool.filter((i) => !isSpicy(i));
      if (nonSpicy.length) pool = nonSpicy;

      const notFried = pool.filter((i) => !hasAny(tagsText(i), ['薯条', '炸', '鸡块', '鸡翅', '麦辣']));
      if (notFried.length) pool = notFried;

      // 关键一步：实测"高达吉士双牛堡""咸蛋黄鸡腿蛋月堡"等新品在营养库里没有条目，
      // 不剔除的话它们会以"未知"身份混进清爽型，输出一张自己都说不出热量的"清爽"卡。
      const withKcal = pool.filter((i) => typeof i.kcal === 'number' && i.kcal > 0);
      if (withKcal.length >= 2) pool = withKcal;

      if (withKcal.length >= 3) {
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
      // 保底：把"整个菜品库里最便宜的那款"无论主题分高低都塞进来。
      // 真实踩过：预算 30 时豪爽型算出 ¥51.9，而"龙焰鸡腿堡 + 圆筒冰淇淋 = ¥32.5"
      // 这个明显更好的解压根没被生成——因为圆筒在豪爽型打分里排不进前 3
      // （热量高、份量小，完全不符合"吃个痛快"），于是候选池里没有它。
      // 便宜的解必须永远在场，选不选是排序的事，生不生成是候选池的事。
      const cheapest = prepared[bucketName].slice().sort((a, b) => a.price - b.price)[0];
      if (cheapest && !map.has(cheapest.code)) {
        map.set(cheapest.code, { item: cheapest, score: themeScore(cheapest, theme.key, ans, ctxTheme).score });
      }
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
    //
    // 精简组合（主食 + 一个配餐）**无条件生成**，不再由"主食是否吃掉 70% 额度"来触发。
    // 原因：真实菜单里主食 ¥26-39、配餐每样 ¥10-17，主食再便宜也顶不住"主食+小食+饮料+甜品"
    // 四件齐上。若只在 tight 时生成二件套，一旦预算贴近主食价，本主题就只剩"超预算"这一个选项
    // （实测：预算 45 时清爽型被迫推 ¥56.4 的四件套，超支 ¥11.4，而 ¥40 的二件套就在旁边）。
    // 生成之后由统一的"预算内 > 超预算"排序去裁决，谁也不用猜。
    const combosFor = (main) => {
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

      // 二件套：主食 + 各桶里"主题最优的前几个"（不是只给最便宜的），
      // 这样清爽型能配到玉米杯+美式，而不是被迫配圆筒冰淇淋。
      const twoPiece = [];
      for (const pool of [...sidePool, drinkPool, dessertPool].filter((p) => p.length)) {
        twoPiece.push(...build([[main], pool]));
      }

      // 三件套（主食 + 小食 + 饮料）：只在能配全时才有意义，
      // 用来覆盖"预算只够三件"和"四件超、三件刚好"的区间。
      const threePiece = [];
      if (!main.item.isCombo && sidePool.length && drinkPool.length) {
        threePiece.push(...build([[main], sidePool, drinkPool]));
      }

      // 降级二件套：只用各桶最便宜的那款。
      // 作用是"用户说要饮料，但预算根本放不下正常配餐"时，宁可给一份朴素的两件套，
      // 也不要把预算全砸在饮料上、主食被迫降级成最便宜那款。
      const liteTwo = [];
      if (!main.item.isCombo && sideLite.length) liteTwo.push(...build([[main], sideLite]));
      if (drinkLite.length) liteTwo.push(...build([[main], drinkLite]));
      if (dessertLite.length) liteTwo.push(...build([[main], dessertLite]));

      return [...full, ...threePiece, ...twoPiece, ...liteTwo];
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
    // 这里的"回退"只治一种病：**去重**把候选缩得太小，导致本可负担的组合被挤掉了。
    // 它治不了"预算真的不够"，所以只在去重后凑不出预算内组合时才试一次；
    // 如果去重前的候选本来也全超，那就别回退——回退只会把刚被剔除的高价套餐（¥49-63）放回来，
    // 让一张"预算 30"的卡变成 ¥51.9 的三件套。（真实踩过）
    // 判据只用"这个主食本身能不能进预算"，不必把整池组合重算一遍（真实菜单 14 个主食 × 几十组合，太贵）。
    const cheapestCompanion = Math.min(
      ...[...sideLite, ...drinkLite, ...dessertLite].map((c) => c.item.price * (c.qty ?? 1)),
      Number.POSITIVE_INFINITY
    );
    const dedupTooTight = !allOptions.some((c) => c.total <= cap);
    const affordableBeforeDedup = ranked.some(
      (m) => m.item.price * qtyFor('mainFood', ans) + (Number.isFinite(cheapestCompanion) ? cheapestCompanion : 0) <= cap
    );
    if (dedupTooTight && affordableBeforeDedup) {
      const fullPool = ranked.slice(0, 8);
      const fallback = fullPool.flatMap((m) => combosFor(m).map((c) => ({ ...c, mainCode: m.item.code })));
      if (fallback.some((c) => c.total <= cap)) candidatesForBudget = fallback;
    }

    /* 二次截断：预算真的不够时，"离谱的贵"比"便宜"更糟。
     * 预算 30 块绝不该蹦出一份 ¥85 的"堡堡随心拼"。之前这段被误写在上面那个 if 内部，
     * 而那个 if 恰恰只在"回退有效"时才成立——于是最需要截断的场景（预算根本不够）
     * 反而永远走不到截断，实测给出了 ¥51.9 的三件套。
     * 现在挪出来，只在"全部候选都超预算"时生效，保证挑出来的东西至少离预算不远。
     */
    if (!candidatesForBudget.some((c) => c.total <= cap)) {
      // 基准取"**本次实际候选里**最便宜的主食"，不是整池最便宜的。
      // 之前用整池算，得出 ¥26 + 20 = ¥46 的上限，于是 ¥51.9 的三件套也合规地留下了；
      // 而实际候选里最便宜的是 ¥27.5，上限应为 ¥47.5，¥51.9 就该被拦掉。
      const cheapestMain = mainCandidates.reduce(
        (min, m) => (m.item.price < min ? m.item.price : min),
        Number.POSITIVE_INFINITY
      );
      const budgetRef = Number.isFinite(ans.budget) ? ans.budget : 30;
      const saneCeil = cheapestMain + Math.max(20, budgetRef * 0.5);
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

    const baselineTotal = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : 0;
    const options = pool.sort((a, b) => {
      // 第一顺位永远是"这一份到底要不要用户多掏钱"。
      // 曾经的写法是 overBudget 时才按"离预算最近"排，其余一律按主题分排——
      // 结果主题分把一张超支 ¥11.4 的四件套排在了一张 ¥40 二件套前面，
      // 只因为"四件套更像一顿完整的饭"（diversityBonus）。钱的事不能输给完整度。
      const aOver = a.total > baselineTotal + 0.01 ? 1 : 0;
      const bOver = b.total > baselineTotal + 0.01 ? 1 : 0;
      if (aOver !== bOver) return aOver - bOver;
      if (overBudget) {
        // 全都超了，预算实在不够：先按超支金额分档，再在档内按主题分挑。
        //
        // 为什么先分档而不是直接"离预算最近"：预算 30、最便宜的鸡堡 ¥26 配圆筒 ¥5 也要 ¥31，
        // 这时"离预算最近"会选一份 ¥31 的两件套——但豪爽型的定义是"吃个痛快"，
        // 它宁可选 ¥32 的加量版，也不该为了省 1 块钱去选个小份。档位容差设 15%，
        // 表达的是"多花这一成以内，值得换更好的东西"；超过一成就说明是在硬撑，不值得。
        const aD = Math.abs(a.total - baselineTotal) / Math.max(baselineTotal, 1);
        const bD = Math.abs(b.total - baselineTotal) / Math.max(baselineTotal, 1);
        const TIER = 0.15;
        const aTier = Math.floor(aD / TIER);
        const bTier = Math.floor(bD / TIER);
        if (aTier !== bTier) return aTier - bTier;
        return b.score - a.score;
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
    /* 差异化只在"同一个价格档位"里做。
     * 之前的写法是 nearTop = options 里分数相差 ≤10 的都算，然后在里面找"主食没用过"的——
     * 排序第一顺位虽然是"要不要多花钱"，但 nearTop 只按分数差筛，天然混进了贵得多的组合，
     * 而便宜的组合往往因为份量小、完整度低反而分低。结果预算 30 的豪爽卡落在 ¥51.9，
     * 而 ¥31 的合规组合就在旁边。现在 nearTop 严格限定在 options[0] 的价格档位内。
     */
    const totalOfCombo = (c) => c.combo.reduce((acc, x) => acc + x.item.price * x.qty, 0);
    const top = options[0];
    const topTotal = top ? totalOfCombo(top) : 0;
    const sameTier = (t) => Math.abs(t - topTotal) / Math.max(topTotal, 1) <= 0.1;
    const nearTop = options.filter((c) => top && top.score - c.score <= 10 && sameTier(totalOfCombo(c)));

    let chosen = top;
    const diffCandidate =
      nearTop.find((c) => !usedMain.has(c.combo[0].item.code) && !usedSignatures.has(signature(c))) ??
      nearTop.find((c) => !usedSignatures.has(signature(c)));
    if (diffCandidate) chosen = diffCandidate;

    // 诚实优先：如果"差异化选择"要超预算，而"最优选择"不超，就用不超的那个。
    // 因为用户对钱的敏感度远高于"三张卡长得不一样"。
    const userBudget = Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : Infinity;
    if (diffCandidate && top && totalOfCombo(diffCandidate) > userBudget && totalOfCombo(top) <= userBudget) {
      chosen = top;
    }

    if (!chosen) continue;
    usedSignatures.add(signature(chosen));

    // 性价比型的"备选解"：全场按价格升序的前 40 个。
    // 只在终局校正时用到——如果打分跑偏让性价比卡比别的卡还贵，就要从这里重新求解。
    themeCandidatePools[theme.key] = candidatesForBudget;
    if (theme.key === 'value') {
      valueCandidates = candidatesForBudget
        .slice()
        .sort((a, b) => a.total - b.total || b.score - a.score)
        .slice(0, 40);
    }

    results.push(makePlan(theme.key, chosen, ans));
  }

  /* 最后一关：性价比型必须是三张卡里最便宜的那张。
   * 这条不是"优化"，是定义——一张比其它两张都贵的"性价比"卡，是自相矛盾的。
   * 出现这种情况说明打分权重跑偏了，这里做**重新求解**，而不是把别人的答案抄过来。
   *
   * 曾经的写法是把"最便宜那张卡"整体复制给性价比型，结果预算 45 时出现
   * 豪爽型与性价比型一模一样的两张卡（芝士安格斯厚牛堡 + 奶铁），
   * 用户看到的是三张卡里有两张重复——比价格算错还难看。
   * 现在的做法：
   *   1. 在"预算内 且 比当前最便宜更便宜"的候选里重新挑，优先主食未被占用的；
   *   2. 实在挑不出来（预算紧到只剩一个解）才允许抄，且必须打 corrected 标记。
   */
  const valueIdx = results.findIndex((p) => p.theme === 'value');
  if (valueIdx >= 0 && results.length >= 2 && valueCandidates.length) {
    const cheapestNow = Math.min(...results.map((p) => p.estimateTotal));

    if (results[valueIdx].estimateTotal > cheapestNow + 0.01) {
      const usedMainCodes = new Set(
        results
          .filter((p) => p.theme !== 'value')
          .map((p) => p.items.find((i) => i.bucket === 'mainFood')?.code)
          .filter(Boolean)
      );
      const usedSigs = new Set(
        results
          .filter((p) => p.theme !== 'value')
          .map((p) => p.items.map((i) => `${i.code}x${i.qty}`).sort().join('|'))
      );
      const sigOf = (c) => c.combo.map((x) => `${x.item.code}x${x.qty}`).sort().join('|');
      const inBudgetPool = valueCandidates.filter(
        (c) => c.total <= (Number.isFinite(ans.budget) ? ans.budget * Math.max(1, ans.people ?? 1) : Infinity) + 0.01
      );
      const searchBase = inBudgetPool.length ? inBudgetPool : valueCandidates;

      const better = (c) => c.total < results[valueIdx].estimateTotal - 0.01;
      const pick =
        searchBase
          .filter((c) => better(c) && !usedMainCodes.has(c.combo[0].item.code) && !usedSigs.has(sigOf(c)))
          .sort((a, b) => a.total - b.total || b.score - a.score)[0] ??
        searchBase.filter((c) => better(c) && !usedSigs.has(sigOf(c))).sort((a, b) => a.total - b.total)[0] ??
        searchBase.filter((c) => better(c)).sort((a, b) => a.total - b.total)[0];

      if (pick) {
        results[valueIdx] = makePlan('value', pick, ans);
      } else {
        // 真的只有唯一解：把最便宜那张交给性价比型，并让原来的持有者重新出一版，
        // 避免出现两张完全相同的卡。
        const winner = results.reduce((a, b) => (a.estimateTotal <= b.estimateTotal ? a : b));
        const otherIdx = results.findIndex((p, i) => i !== valueIdx && p === winner);
        const takenSig = winner.items.map((i) => `${i.code}x${i.qty}`).sort().join('|');
        const takenMain = winner.items.find((i) => i.bucket === 'mainFood')?.code;
        results[valueIdx] = { ...winner, theme: 'value', label: results[valueIdx].label, tagline: results[valueIdx].tagline, corrected: true };
        if (otherIdx >= 0) {
          const repl = valueCandidates
            .filter((c) => sigOf(c) !== takenSig && c.combo[0].item.code !== takenMain)
            .sort((a, b) => b.score - a.score)[0];
          results[otherIdx] = repl
            ? makePlan(results[otherIdx].theme, repl, ans)
            : { ...results[otherIdx], corrected: true };
        }
      }
    }
  }

  /* 收尾：三张卡不许有两张一模一样。
   * 上面那条只保证"性价比卡最便宜"，但如果预算紧到只剩一个解，
   * 豪爽型和性价比型会拿到同一份菜单（实测预算 30：两张卡都是 ¥31 麦辣鸡腿堡+圆筒）。
   * 用户看到的不是"两个主题殊途同归"，而是"你的程序出错了吧"。
   * 处理方式：让后出现的那张卡在"自己主题的候选池"里换一个主食，
   * 哪怕贵一点、分数低一点——只要还是同价位、不同东西，就比重复强。
   */
  const sigOfPlan = (p) => p.items.map((i) => `${i.code}x${i.qty}`).sort().join('|');
  const seen = new Map();
  for (let i = 0; i < results.length; i++) {
    const sg = sigOfPlan(results[i]);
    if (!seen.has(sg)) {
      seen.set(sg, i);
      continue;
    }
    // 撞车：从同主题候选里找一个"没被用过的主食"且总价相近的
    const pool = (themeCandidatePools[results[i].theme] ?? []).filter(
      (c) => sigOfPlan({ items: c.combo.map((x) => ({ code: x.item.code, qty: x.qty })) }) !== sg
    );
    // 换卡有两个硬条件：
    //   1. 不能撞上其它卡（这是去重的本意）；
    //   2. 不能把自己换成"比另一张卡还贵"——尤其是性价比卡。
    //      实测预算 ¥20 时，性价比卡本来是 ¥22（全场最便宜），去重时为了跟豪爽卡区分，
    //      换成了 ¥26 的可乐版，结果"性价比"比"豪爽"还贵。去重不能制造新矛盾。
    const isValue = results[i].theme === 'value';
    const cheapestOther = Math.min(...results.filter((p, j) => j !== i).map((p) => p.estimateTotal));
    const priceCeiling = isValue ? cheapestOther - 0.01 : Number.POSITIVE_INFINITY;
    const alt =
      pool
        .filter((c) => !results.some((p, j) => j !== i && sigOfPlan(p) === sigOfPlan({ items: c.combo.map((x) => ({ code: x.item.code, qty: x.qty })) })))
        .filter((c) => c.total <= priceCeiling)
        .sort((a, b) => Math.abs(a.total - results[i].estimateTotal) - Math.abs(b.total - results[i].estimateTotal) || b.score - a.score)[0];
    if (alt) {
      results[i] = makePlan(results[i].theme, alt, ans);
      seen.set(sigOfPlan(results[i]), i);
    }
  }

  /* 主题定义校验：豪爽型必须是三张卡里"最猛"的那张。
   * 实测预算 45 时豪爽型给了 485 kcal（麦辣鸡腿堡+苹果汁），
   * 而性价比型是 633 kcal（麦辣鸡腿堡+奶铁）——两张卡主食相同，配餐却让性价比卡更"猛"。
   * "豪爽"如果连热量都输，这个标签就是骗人的。
   * 处理：热量可比的卡之间，豪爽型不得低于其它卡；否则在它自己的候选池里换一个更猛的。
   * 注意只在"有热量数据可比"时执行——热量缺失不等于 0，不能拿 null 去比大小。
   */
  const heartyIdx = results.findIndex((p) => p.theme === 'hearty');
  if (heartyIdx >= 0 && results.length >= 2 && themeCandidatePools.hearty) {
    const others = results.filter((p) => p.theme !== 'hearty' && typeof p.totalKcal === 'number');
    const hk = results[heartyIdx].totalKcal;
    if (others.length && typeof hk === 'number') {
      const maxOther = Math.max(...others.map((p) => p.totalKcal));
      if (hk < maxOther) {
        const sigNow = results.map((p) => p.items.map((i) => `${i.code}x${i.qty}`).sort().join('|'));
        // 关键约束：换得"更猛"不能顺带变得"更贵"。
        // 第一版只按热量降序挑，结果预算 45 的豪爽卡直接从 ¥40.5 跳到 ¥50.4（超支 ¥5.4），
        // 而另一张 ¥35.9 的卡热量还更高——用"多花钱"去换"更猛"是典型的双输。
        // 所以只允许在"不比当前这张贵"的候选里找，找不到就承认这张卡已经是最佳取舍。
        const priceNow = results[heartyIdx].estimateTotal;
        const hotter = themeCandidatePools.hearty
          .map((c) => ({
            c,
            kcal: c.combo.reduce((a, x) => a + (typeof x.item.kcal === 'number' ? x.item.kcal * x.qty : 0), 0),
          }))
          .filter((x) => x.kcal > hk)
          .filter((x) => x.c.total <= priceNow + 0.01)
          .filter((x) => !sigNow.includes(x.c.combo.map((y) => `${y.item.code}x${y.qty}`).sort().join('|')))
          .sort((a, b) => b.kcal - a.kcal || b.c.score - a.c.score)[0];
        if (hotter) results[heartyIdx] = makePlan('hearty', hotter.c, ans);
      }
    }
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
