#!/usr/bin/env node
/**
 * 麦门大冒险 · MCP 适配器 mcp_adapter.mjs
 * ------------------------------------------------------------
 * 把麦当劳 MCP 的真实返回，转成 build_pool.mjs 认识的菜单结构。
 *
 * 真实 query-meals 返回长这样（2026-10 实测）：
 *   {
 *     categories: [ { name: "人气热卖", meals: ["9900016076", ...] }, ... ],
 *     meals: {
 *       "1100": { name: "巨无霸", currentPrice: "29", originalPrice: "29",
 *                 image: "...", canWithOrder: false, discountType: "..." }
 *     }
 *   }
 *
 * 几个必须小心的真实特性：
 *   1. meals 是 {code: item} 的字典，不是数组
 *   2. 同一餐品会出现在多个分类里（人气热卖 = 其它分类的并集）
 *   3. 价格是字符串，可能带促销原价（currentPrice vs originalPrice）
 *   4. 没有 calories 字段 —— 必须靠 list-nutrition-foods 另取
 *   5. 没有 soldOut 字段 —— 用 canWithOrder 判断；但 86/88 都是 false，
 *      所以 canWithOrder 不等于"售罄"，不能拿它过滤，只能当提示
 */

/* ============================================================
 * 1. 门店
 * ============================================================ */

export function normalizeStore(raw) {
  return {
    storeCode: String(raw.storeCode ?? ''),
    storeName: raw.storeName ?? '',
    address: raw.address ?? '',
    distance: typeof raw.distance === 'number' ? raw.distance : null,
    /** 营业中 */
    open: raw.businessStatus !== false,
    businessHours:
      raw.businessStartTime && raw.businessEndTime
        ? `${raw.businessStartTime}-${raw.businessEndTime}`
        : null,
    reservation: raw.reservation === true,
  };
}

/** 门店列表按距离升序，最多取 n 家（剧情里只展示 3 家） */
export function pickStores(list, n = 3) {
  const arr = Array.isArray(list) ? list.map(normalizeStore) : [];
  return arr
    .filter((s) => s.storeCode)
    .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
    .slice(0, n);
}

/* ============================================================
 * 2. 菜单
 * ============================================================ */

/**
 * 把 query-meals 的 data 转成 build_pool 可吃的结构
 * 输出刻意对齐 normalizeMenu 支持的字段名：categories[].items[]
 */
export function adaptMenu(data, opts = {}) {
  const meals = data?.meals ?? {};
  const categories = data?.categories ?? [];

  // 反查：每个餐品属于哪些分类（一个餐品可能属于多个）
  const catOf = new Map();
  for (const c of categories) {
    const name = String(c.name ?? '').replace(/\s+/g, ' / ').trim();
    for (const code of c.meals ?? []) {
      if (!catOf.has(String(code))) catOf.set(String(code), []);
      catOf.get(String(code)).push(name);
    }
  }

  // 「人气热卖」只是运营位，不是真实品类，做分桶时降权
  const isHotSlot = (names) => names.every((n) => /人气热卖|热卖|推荐/.test(n));

  const items = [];
  for (const [code, m] of Object.entries(meals)) {
    const names = catOf.get(String(code)) ?? [];
    const price = toPrice(m.currentPrice);
    const original = toPrice(m.originalPrice);
    items.push({
      code: String(code),
      name: String(m.name ?? '').trim(),
      price,
      originalPrice: Number.isFinite(original) && original > price ? original : null,
      /** 用来分桶的分类名（去掉人气位） */
      categories: isHotSlot(names) ? [] : names,
      rawCategories: names,
      image: m.image ?? null,
      /** 促销类型，如"随单购麦金卡优惠" */
      promo: m.discountType ?? null,
      /** 仅作参考，不用于过滤（实测 86/88 都为 false） */
      canWithOrder: m.canWithOrder !== false,
      tags: [],
      status: 'ON_SALE',
    });
  }

  // 只保留有名字有价格的
  const clean = items.filter((i) => i.name && Number.isFinite(i.price) && i.price > 0);

  return {
    meta: {
      source: 'mcp.mcd.cn · query-meals',
      storeCode: opts.storeCode ?? null,
      storeName: opts.storeName ?? null,
      snapshotDate: opts.snapshotDate ?? null,
      total: clean.length,
    },
    categories: toCategoryGroups(clean),
    items: clean,
  };
}

function toPrice(v) {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** 按第一个"真实分类"把餐品分组，供 normalizeMenu 使用 */
function toCategoryGroups(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.categories[0] ?? '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, items: list }));
}

/* ============================================================
 * 3. 价格计算结果的归一化
 * ============================================================ */

export function normalizePriceResult(data) {
  if (!data || typeof data !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    subtotal: num(data.productPrice ?? data.subtotal ?? data.totalPrice),
    deliveryFee: num(data.deliveryPrice ?? data.deliveryFee) ?? 0,
    discount: num(data.discountPrice ?? data.discount) ?? 0,
    payable: num(data.payPrice ?? data.payable ?? data.totalAmount),
    raw: data,
  };
}
