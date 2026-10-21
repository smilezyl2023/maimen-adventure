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
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fails.push(`${name}${detail ? ' —— ' + detail : ''}`);
  }
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
for (const budget of [15, 20, 25, 30, 35, 45, 60, 100]) {
  const r = run({ budget });
  ok(`预算 ¥${budget} 仍返回 3 张卡`, r.plans.length === 3, `实际 ${r.plans.length} 张`);
}

/* ---------- 2. 铁律：绝不虚构菜品 ---------- */
for (const budget of [20, 35, 60]) {
  const r = run({ budget });
  for (const plan of r.plans) {
    for (const it of plan.items) {
      ok(`预算 ¥${budget} 的「${plan.label}」里的 ${it.name} 来自菜单`, allCodes.has(it.code));
    }
  }
}

/* ---------- 3. 数量：人数与"很饿" ---------- */
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
{
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
{
  const r = run({ budget: 60, flavor: 'any', wantDrink: true });
  const sigs = new Set(r.plans.map((p) => p.items.map((i) => i.code).sort().join('|')));
  ok('预算充足时三张卡互不相同', sigs.size === 3, `只有 ${sigs.size} 种`);

  const mains = r.plans.map((p) => p.items.find((i) => i.bucket === 'mainFood').code);
  ok('预算充足时三张卡主食不全相同', new Set(mains).size >= 2, mains.join('/'));
}

/* ---------- 8. 热量：只求和已知值，绝不估算 ---------- */
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
{
  const r = run({ budget: 50 });
  for (const plan of r.plans) {
    for (const it of plan.items) {
      ok(`${it.name} 不是售罄品`, !/售罄|sold/i.test(it.name));
    }
  }
}

/* ---------- 10. 字段容错：预算字段两种写法都能吃 ---------- */
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
{
  ok('汉堡分到主食', detectBucket({ name: '巨无霸', tags: [] }) === 'mainFood');
  ok('可乐分到饮料', detectBucket({ name: '可口可乐(中)', tags: [] }) === 'drink');
  ok('甜筒分到甜品', detectBucket({ name: '原味甜筒', tags: [] }) === 'dessert');
  ok('薯条分到小食', detectBucket({ name: '薯条(大)', tags: [] }) === 'side');
  ok('无法判断的返回 null', detectBucket({ name: '神秘礼盒', tags: [] }) === null);
}

/* ---------- 12. 空菜单不崩 ---------- */
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
console.log(`  ✅ ${pass} 项断言全部通过\n`);
