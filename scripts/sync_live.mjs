#!/usr/bin/env node
/**
 * 麦门大冒险 · 真实菜单快照 sync_live.mjs
 * ------------------------------------------------------------
 * 用真实 MCP 拉一次门店菜单 + 营养数据，落成 assets/live-*.json。
 * 快照随后被 build_pool.mjs / demo.html 直接消费 —— 这样 Demo 里显示的
 * 是"某一天某家店的真实数据"，而不是我手写的示例。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/sync_live.mjs --city 上海 --keyword 陆家嘴
 *   MCD_MCP_TOKEN=xxx node scripts/sync_live.mjs --store 1450127
 *
 * 注意：Token 只从环境变量读，绝不写进仓库。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { adaptMenu, pickStores } from './mcp_adapter.mjs';
import { attachNutrition } from './nutrition.mjs';
import { normalizeMenu } from './build_pool.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://mcp.mcd.cn';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

/** 单次 JSON-RPC 调用 */
async function callTool(token, name, args, id = 1) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const json = await res.json();
  const result = json.result ?? {};
  const sc = result.structuredContent ?? {};
  return {
    ok: sc.success !== false && !result.isError,
    code: sc.code ?? null,
    message: sc.message ?? null,
    data: sc.data ?? null,
    text: (result.content ?? []).map((c) => c.text).join('\n'),
  };
}

async function main() {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    console.error('缺少 MCD_MCP_TOKEN 环境变量。用法：MCD_MCP_TOKEN=xxx node scripts/sync_live.mjs');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));

  /* 1. 找门店 */
  let store;
  if (args.store) {
    store = { storeCode: String(args.store), storeName: args.name ?? '' };
  } else {
    const city = args.city ?? '上海';
    const keyword = args.keyword ?? '陆家嘴';
    const r = await callTool(token, 'query-nearby-stores', { city, keyword, beType: 1, searchType: 2 });
    if (!r.ok || !Array.isArray(r.data) || !r.data.length) {
      throw new Error(`门店查询失败：${r.code} ${r.message}`);
    }
    const stores = pickStores(r.data, 3);
    console.log('附近门店：');
    for (const s of stores) {
      console.log(`  ${s.storeName} · ${s.distance}m · ${s.open ? '营业中' : '休息中'} · ${s.businessHours ?? ''}`);
    }
    store = stores[0];
    writeFileSync(
      resolve(ROOT, 'assets/live-stores.json'),
      `${JSON.stringify({ meta: { city, keyword, fetchedAt: new Date().toISOString() }, stores }, null, 2)}\n`
    );
  }
  console.log(`\n选定门店：${store.storeName || store.storeCode} (${store.storeCode})`);

  /* 2. 拉菜单 */
  const mealsRes = await callTool(token, 'query-meals', {
    storeCode: store.storeCode,
    orderType: 1,
    beType: 1,
  });
  if (!mealsRes.ok) throw new Error(`菜单查询失败：${mealsRes.code} ${mealsRes.message}`);

  const adapted = adaptMenu(mealsRes.data, {
    storeCode: store.storeCode,
    storeName: store.storeName,
    snapshotDate: new Date().toISOString().slice(0, 10),
  });
  console.log(`菜单：${adapted.items.length} 个在售餐品`);

  /* 3. 拉营养并合并 */
  const nutriRes = await callTool(token, 'list-nutrition-foods', {}, 3);
  let merged = adapted;
  if (nutriRes.ok) {
    const base = normalizeMenu(adapted);
    const n = attachNutrition(base, nutriRes.data);
    const items = n.items.map((i) => ({
      code: i.code,
      name: i.name,
      price: i.price,
      categories: adapted.items.find((x) => x.code === i.code)?.categories ?? [],
      originalPrice: adapted.items.find((x) => x.code === i.code)?.originalPrice ?? null,
      promo: adapted.items.find((x) => x.code === i.code)?.promo ?? null,
      kcal: i.kcal ?? null,
      kcalSource: i.kcalSource ?? null,
      tags: [],
      status: 'ON_SALE',
    }));
    merged = { ...adapted, items };
    console.log(`营养匹配：${n.matched}/${n.total} 个餐品拿到热量（库中声明 ${n.declared} 条）`);
    if (n.missing.length) console.log(`  未匹配 ${n.missing.length} 个：${n.missing.slice(0, 8).join('、')}${n.missing.length > 8 ? ' …' : ''}`);
    if (n.assumed.length) console.log(`  按别名取值的 ${n.assumed.length} 个：${n.assumed.slice(0, 6).join('；')}${n.assumed.length > 6 ? ' …' : ''}`);
  } else {
    console.log(`营养数据获取失败（${nutriRes.code}），热量将显示"暂缺"`);
  }

  /* 4. 落盘 */
  const out = {
    meta: {
      ...merged.meta,
      nutritionApi: nutriRes.ok ? 'list-nutrition-foods' : null,
      note: '本文件由 scripts/sync_live.mjs 从 mcp.mcd.cn 实时拉取，价格与供应状态以门店当日报价为准。',
    },
    categories: merged.categories,
    items: merged.items,
  };
  const dest = resolve(ROOT, 'assets/live-menu.json');
  writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n已写入 ${dest.replace(ROOT + '/', '')}`);

  /* 5. 顺手跑一遍组餐，做个冒烟测试 */
  const { buildMenu } = await import('./build_pool.mjs');
  const res = buildMenu(out, {
    budget: 45,
    hunger: 'normal',
    flavor: 'any',
    spice: 'mild',
    people: 1,
    wantDrink: true,
    wantDessert: false,
  });
  const s = res.menuStats.buckets;
  console.log(`\n冒烟测试：
  分桶 → 主食 ${s.mainFood} / 小食 ${s.side} / 饮料 ${s.drink} / 甜品 ${s.dessert}
  三张卡 → ${res.plans.map((p) => `${p.label} ¥${p.estimateTotal}`).join(' | ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e.stack ?? e));
    process.exit(1);
  });
}
