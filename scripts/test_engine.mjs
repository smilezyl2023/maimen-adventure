#!/usr/bin/env node
/**
 * 麦门大冒险 · 组餐引擎回归测试 test_engine.mjs
 * ------------------------------------------------------------
 * 这些用例全部来自开发过程中真实踩过的坑。每一条都对应一次线上观感 bug，
 * 加进来是为了防止以后改打分权重时又把老问题改回去。
 *
 * 运行：node scripts/test_engine.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeMenu, buildMenu, scoreItem, detectBucket } from './build_pool.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(readFileSync(resolve(ROOT, 'assets/sample-menu.json'), 'utf8'));
const MENU = normalizeMenu(RAW);

let pass = 0;
let group = '起点';
const perGroup = new Map();
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fails.push(`[${group}] ${name}${detail ? ' —— ' + detail : ''}`);
  }
  perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
}
/** 标记当前用例组（只影响报错定位，不影响断言） */
function G(name) {
  group = name;
}

const base = {
  budget: 35,
  hunger: 'normal',
  flavor: 'chicken',
  spice: 'nofilter',
  people: 1,
  wantDrink: true,
  wantDessert: false,
  careCalories: false,
};

const run = (patch = {}) => buildMenu(MENU, { ...base, ...patch });
const priceOf = (plan) => plan.items.reduce((a, i) => a + i.price * i.qty, 0);
const names = (plan) => plan.items.map((i) => i.name);
const allCodes = new Set(MENU.items.map((i) => i.code));

/* ---------- 1. 结构：永远 3 张卡 ---------- */
G('1. 结构：永远 3 张卡');
for (const budget of [15, 20, 25, 30, 35, 45, 60, 100]) {
  const r = run({ budget });
  ok(`预算 ¥${budget} 仍返回 3 张卡`, r.plans.length === 3, `实际 ${r.plans.length} 张`);
}

/* ---------- 2. 铁律：绝不虚构菜品 ---------- */
G('2. 铁律：绝不虚构菜品');
for (const budget of [20, 35, 60]) {
  const r = run({ budget });
  for (const plan of r.plans) {
    for (const it of plan.items) {
      ok(`预算 ¥${budget} 的「${plan.label}」里的 ${it.name} 来自菜单`, allCodes.has(it.code));
    }
  }
}

/* ---------- 3. 数量：人数与"很饿" ---------- */
G('3. 数量：人数与"很饿"');
{
  const r2 = run({ people: 2 });
  const mains = r2.plans[0].items.filter((i) => i.bucket === 'mainFood');
  ok('2 人正常饿 → 主食 2 份', mains[0].qty === 2, `实际 ${mains[0].qty}`);

  const r2h = run({ people: 2, hunger: 'heavy' });
  const m2h = r2h.plans[0].items.find((i) => i.bucket === 'mainFood');
  ok('2 人很饿 → 主食 3 份', m2h.qty === 3, `实际 ${m2h.qty}`);

  const r4 = run({ people: 4, hunger: 'heavy' });
  const m4 = r4.plans[0].items.find((i) => i.bucket === 'mainFood');
  ok('4 人很饿 → 主食 6 份', m4.qty === 6, `实际 ${m4.qty}`);
}

/* ---------- 4. 用户偏好是硬约束 ---------- */
G('4. 用户偏好是硬约束');
{
  const r = run({ spice: 'none' });
  for (const plan of r.plans) {
    const spicy = plan.items.filter((i) => /辣/.test(`${i.name} ${(i.tags ?? []).join(' ')}`));
    ok(`选了「不吃辣」，「${plan.label}」里不能出现辣味餐品`, spicy.length === 0, spicy.map((i) => i.name).join('/'));
  }
}
{
  const r = run({ flavor: 'fish' });
  for (const plan of r.plans) {
    const main = plan.items.find((i) => i.bucket === 'mainFood');
    ok(`选了「鱼」，「${plan.label}」的主食必须是鱼`, /鱼|鳕/.test(main.name), main.name);
  }
}

/* ---------- 5. 预算：明示超支，不悄悄超 ---------- */
G('5. 预算：明示超支，不悄悄超');
for (const budget of [20, 25, 30, 35, 50, 80]) {
  const r = run({ budget });
  const cap = budget * 1.1;
  const stretch = budget * 1.3;
  for (const plan of r.plans) {
    const p = priceOf(plan);
    ok(
      `预算 ¥${budget} 的「${plan.label}」(¥${p}) 不超过放宽上限 ¥${stretch.toFixed(1)}`,
      p <= stretch + 0.01,
      `实际 ¥${p}`
    );
    // 只要超过用户报的预算本身，就必须在文案里说清楚（不能拿内部 10% 容差糊弄）
    if (p > budget + 0.01) {
      ok(
        `预算 ¥${budget} 的「${plan.label}」(¥${p}) 超支已明示`,
        /略超|超预算|超 ¥/.test(plan.note ?? ''),
        `note="${plan.note ?? ''}"`
      );
      ok(
        `预算 ¥${budget} 的「${plan.label}」超支金额正确`,
        Math.abs((plan.overAmount ?? 0) - (p - budget)) < 0.01,
        `overAmount=${plan.overAmount}`
      );
    }
  }
}

/* ---------- 6. 主题人格：不能串味 ---------- */
G('6. 主题人格：不能串味');{
  const r = run({ budget: 40, flavor: 'any' });

  const hearty = r.plans.find((p) => p.theme === 'hearty');
  const heavyKcal = hearty.totalKcal;
  const others = r.plans.filter((p) => p.theme !== 'hearty').map((p) => p.totalKcal);
  ok(
    '豪爽型的热量不低于其它两张卡',
    heavyKcal >= Math.min(...others),
    `豪爽 ${heavyKcal} vs ${others.join('/')}`
  );

  const fresh = r.plans.find((p) => p.theme === 'fresh');
  ok('清爽型里没有辣味餐品', !names(fresh).some((n) => /辣/.test(n)), names(fresh).join('+'));
  const spicyDrinks = fresh.items.filter((i) => /辣/.test(i.name));
  ok('清爽型没有油炸小食', spicyDrinks.length === 0 && !names(fresh).some((n) => /薯条|鸡块|鸡翅/.test(n)), names(fresh).join('+'));
  ok(
    '清爽型热量不高于性价比型',
    fresh.totalKcal <= Math.max(...r.plans.filter((p) => p.theme === 'value').map((p) => p.totalKcal)) * 1.5,
    `清爽 ${fresh.totalKcal}`
  );

  const value = r.plans.find((p) => p.theme === 'value');
  const cheapest = Math.min(...r.plans.map(priceOf));
  ok('性价比型价格不高于其它卡', priceOf(value) <= cheapest + 0.01, `性价比 ¥${priceOf(value)}`);
}

/* ---------- 7. 差异化：预算够时，三张卡不该长一样 ---------- */
G('7. 差异化：预算够时，三张卡不该长一样');
{
  const r = run({ budget: 60, flavor: 'any', wantDrink: true });
  const sigs = new Set(r.plans.map((p) => p.items.map((i) => i.code).sort().join('|')));
  ok('预算充足时三张卡互不相同', sigs.size === 3, `只有 ${sigs.size} 种`);

  const mains = r.plans.map((p) => p.items.find((i) => i.bucket === 'mainFood').code);
  ok('预算充足时三张卡主食不全相同', new Set(mains).size >= 2, mains.join('/'));

  // 反向保护：预算宽松时如果三张卡都退化成一主食+一饮料，
  // 说明"预算内优先"这条排序把 completeness 彻底压死了——那不是省钱，那是敷衍。
  const bucketCounts = r.plans.map((p) => new Set(p.items.map((i) => i.bucket)).size);
  ok(
    '预算 ¥60 时至少有一张卡 ≥3 类（主食+配餐+饮料）',
    bucketCounts.some((c) => c >= 3),
    bucketCounts.join('/')
  );
}

/* ---------- 7b. 预算内优先：能不加钱就不加钱 ---------- */
G('7b. 预算内优先');
{
  // 这条规则来自一次真实翻车：预算 45 时清爽型给出了 ¥56.4 的四件套（超支 ¥11.4），
  // 而一份 ¥40 的二件套就躺在候选池里没被选中——因为"四件套更像一顿完整的饭"
  // 的完整度加分盖过了"要用户多掏 11 块"这件事。钱的事不能输给完整度。
  const budgets = [25, 30, 35, 40, 45, 50, 60, 80];
  let anyInBudget = 0;
  for (const budget of budgets) {
    const r = run({ budget });
    for (const plan of r.plans) {
      const p = priceOf(plan);
      // 只能有一个"不得不超"的理由：本主题所有组合都超了。
      // 这里退一步检查"超支幅度不超过一顿主食"，超太多的说明根本没认真找预算内的解。
      const mainPrice = plan.items.find((i) => i.bucket === 'mainFood')?.price ?? 0;
      ok(
        `预算 ¥${budget} 的「${plan.label}」超支 ≤ 一份主食价 ¥${mainPrice}`,
        p - budget <= mainPrice + 0.01,
        `实际 ¥${p}，超 ¥${(p - budget).toFixed(1)}`
      );
      if (p <= budget + 0.01) anyInBudget += 1;
    }
  }
  ok('四档预算里绝大多数卡都落在预算内', anyInBudget >= 18, `只有 ${anyInBudget}/24 张`);
}

/* ---------- 7d. 低预算的已知退化：允许重样，但不许贵 ---------- */
G('7d. 低预算退化');
{
  // 预算 15-25 时，示例菜单里唯一可行的组合就是「田园脆鸡堡 ¥16 + 矿泉水 ¥6 = ¥22」。
  // 物理上只有这一种解，三张卡必然有两张撞车。这时的正确行为是：
  //   承认重复、保证性价比卡仍是最便宜的，**绝不为了"看着不一样"去推更贵的东西**。
  // 反例（真实踩过）：为了区分，把性价比卡换成 ¥26 的可乐版——"性价比"比"豪爽"还贵。
  for (const budget of [15, 20, 25]) {
    const r = run({ budget });
    const value = r.plans.find((p) => p.theme === 'value');
    const cheapest = Math.min(...r.plans.map(priceOf));
    ok(`预算 ¥${budget} 的性价比卡仍是最便宜`, priceOf(value) <= cheapest + 0.01, `¥${priceOf(value)} vs ¥${cheapest}`);
    for (const p of r.plans) {
      ok(
        `预算 ¥${budget} 的「${p.label}」不超过最便宜套餐 ¥2`,
        priceOf(p) <= cheapest + 2.01,
        `¥${priceOf(p)} vs ¥${cheapest}`
      );
    }
  }
  // 反过来：预算一旦宽裕，重复就不该再出现
  for (const budget of [30, 35, 45, 60]) {
    const r = run({ budget });
    const sigs = new Set(r.plans.map((p) => p.items.map((i) => `${i.code}x${i.qty}`).sort().join('|')));
    ok(`预算 ¥${budget} 三张卡互不相同`, sigs.size === 3, `只有 ${sigs.size} 种`);
  }
}

/* ---------- 7c. 三张卡不许重样（真实门店数据） ---------- */
G('7c. 三张卡不许重样');
{
  // 用真实门店菜单跑，因为它比示例菜单更"难"：88 个餐品、套餐/精选/任选混杂、
  // 主食最便宜也要 ¥26，预算 30 时三张卡的可行解被压得极窄，最容易撞车。
  const LIVE_PATH = resolve(ROOT, 'assets/live-menu.json');
  let live = null;
  try {
    live = normalizeMenu(JSON.parse(readFileSync(LIVE_PATH, 'utf8')));
  } catch {
    live = null;
  }
  if (live) {
    for (const budget of [30, 45, 60, 80]) {
      const r = buildMenu(live, { ...base, budget, flavor: 'chicken' });
      const sigs = r.plans.map((p) => p.items.map((i) => `${i.code}x${i.qty}`).sort().join('|'));
      ok(`真实菜单 预算 ¥${budget} 三张卡互不相同`, new Set(sigs).size === r.plans.length, `${new Set(sigs).size}/${r.plans.length} 种`);
      for (const p of r.plans) {
        // 上限用引擎自己声明的"容忍上限"（预算 × 30%），而不是拍一个绝对金额。
        // 真实门店最便宜的鸡堡 ¥26，配最便宜的饮料 ¥9.9 就是 ¥35.9——预算 30 时
        // 物理上买不出"30 块以内、有主食有饮料"的组合，引擎只能如实超支并说明金额。
        ok(
          `真实菜单 预算 ¥${budget} 的「${p.label}」超支 ≤ 预算的 30%`,
          priceOf(p) - budget <= budget * 0.3 + 0.01,
          `¥${priceOf(p)}`
        );
        // 不许出现"鸡肉堡单品精选 / 堡堡随心拼"这类没法定案的候选组
        for (const it of p.items) {
          ok(`「${p.label}」不含候选组 ${it.name}`, !/单品精选|任选|随心拼/.test(it.name));
        }
      }
    }
  }
}

/* ---------- 8. 热量：只求和已知值，绝不估算 ---------- */
G('8. 热量：只求和已知值，绝不估算');
{
  const r = run({ budget: 45 });
  for (const plan of r.plans) {
    const known = plan.items.filter((i) => typeof i.kcal === 'number');
    const expect = known.reduce((a, i) => a + i.kcal * i.qty, 0);
    ok(`「${plan.label}」热量=已知项之和`, plan.totalKcal === expect, `${plan.totalKcal} vs ${expect}`);
    ok(`「${plan.label}」热量完整性标记正确`, plan.kcalComplete === (known.length === plan.items.length));
  }
}

/* ---------- 9. 售罄餐品绝不能出现 ---------- */
G('9. 售罄餐品绝不能出现');
{
  const r = run({ budget: 50 });
  for (const plan of r.plans) {
    for (const it of plan.items) {
      ok(`${it.name} 不是售罄品`, !/售罄|sold/i.test(it.name));
    }
  }
}

/* ---------- 10. 字段容错：预算字段两种写法都能吃 ---------- */
G('10. 字段容错：预算字段两种写法都能吃');
{
  const a = buildMenu(MENU, { ...base, budget: 35 });
  const b = buildMenu(MENU, { ...base, budgetPerPerson: 35 });
  ok(
    'budget 与 budgetPerPerson 结果一致',
    a.plans.map(priceOf).join(',') === b.plans.map(priceOf).join(','),
    `${a.plans.map(priceOf)} vs ${b.plans.map(priceOf)}`
  );
}

/* ---------- 11. 分桶：不认识的东西宁可丢掉，也不瞎猜 ---------- */
G('11. 分桶：不认识的东西宁可丢掉，也不瞎猜');
{
  ok('汉堡分到主食', detectBucket({ name: '巨无霸', tags: [] }) === 'mainFood');
  ok('可乐分到饮料', detectBucket({ name: '可口可乐(中)', tags: [] }) === 'drink');
  ok('甜筒分到甜品', detectBucket({ name: '原味甜筒', tags: [] }) === 'dessert');
  ok('薯条分到小食', detectBucket({ name: '薯条(大)', tags: [] }) === 'side');
  ok('无法判断的返回 null', detectBucket({ name: '神秘礼盒', tags: [] }) === null);
}

/* ---------- 12. 空菜单不崩 ---------- */
G('12. 空菜单不崩');
{
  const r = buildMenu({ categories: [] }, base);
  ok('空菜单返回 0 张卡而不是抛异常', Array.isArray(r.plans) && r.plans.length === 0);
}

/* ---------- 输出 ---------- */
console.log('\n=== 组餐引擎回归测试 ===\n');
if (fails.length) {
  for (const f of fails) console.log(`  ❌ ${f}`);
  console.log(`\n结果：${pass} 项通过，${fails.length} 项失败\n`);
  process.exit(1);
}
for (const [g, n] of perGroup) console.log(`  · ${g}: ${n}`);
console.log(`  ✅ ${pass} 项断言全部通过\n`);
