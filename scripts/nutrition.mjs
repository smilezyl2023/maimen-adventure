#!/usr/bin/env node
/**
 * 麦门大冒险 · 营养数据聚合 nutrition.mjs
 * ------------------------------------------------------------
 * 为什么需要它：
 *   query-meals 返回的 88 个餐品里，一个热量字段都没有。
 *   但 MCP 有 list-nutrition-foods，返回 160 条「餐品名 → kcal」。
 *   两份数据的命名体系完全不同（菜单叫「巨无霸」，营养库也叫「巨无霸」，但
 *   菜单叫「薯条」时营养库分中/大/小杯），所以必须做一层显式映射。
 *
 * 设计原则：
 *   1. 只做「确定的映射」，宁可匹配不上也不猜 —— 猜错热量比没有热量更糟
 *   2. 映射表写死在这个文件里，可审阅、可增补
 *   3. 有歧义的（如「薯条」不分大中小）按默认款式取，并在 note 里标注假设
 */

/* ============================================================
 * 1. 解析 list-nutrition-foods 的文本返回
 * ============================================================ */

/**
 * 原始返回格式：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 */
export function parseNutritionText(text) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  const total = (text.match(/^\[(\d+)\]/) ?? [])[1];

  for (const raw of text.split('\n')) {
    if (!raw.startsWith('  ')) continue;
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length < 9) continue;
    const [productName, , energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium] = parts;
    const kcal = Number(energyKcal);
    if (!productName || !Number.isFinite(kcal)) continue;
    out.set(productName, {
      name: productName,
      kcal,
      kj: Number(energyKj),
      protein: Number(protein),
      fat: Number(fat),
      carb: Number(carbohydrate),
      sodium: Number(sodium),
      calcium: Number(calcium),
    });
  }
  return Object.assign(out, { __declared: total ? Number(total) : null });
}

/* ============================================================
 * 2. 菜单名 → 营养库名 的显式映射
 * ============================================================ */

/** 完全相同，直接取 */
const EXACT = [
  '巨无霸', '麦香鱼', '麦香鸡', '板烧鸡腿堡', '双层吉士汉堡', '吉士汉堡包',
  '麦辣鸡腿汉堡', '不素之霸双层牛堡', '双层深海鳕鱼堡', '培根安格斯厚牛堡',
  '芝士安格斯厚牛堡', '纯悦', '苹果片', '锡兰红茶', '卡布奇诺中杯', '卡布奇诺大杯',
];

/** 菜单名 → 营养库名（需要换算或指定款式） */
const ALIAS = {
  麦辣鸡腿汉堡: '麦辣鸡腿汉堡',
  '麦当劳奶昔': null, // 营养库没有奶昔，如实留空
  薯条: '中薯条',        // 菜单不区分规格，取中份并在 note 标注
  玉米杯: '大杯玉米杯',
  麦乐鸡: '麦乐鸡5块',
  麦辣鸡翅: '麦辣鸡翅-2块',
  圆筒冰淇淋: '圆筒冰淇淋',
  派: '香芋派',          // 菜单只有一个"派"入口，默认香芋
  纯牛奶盒装: '纯牛奶（盒装）',
  '100%苹果汁盒装': '100%苹果汁',
  麦麦脆汁鸡1块: '麦麦脆汁鸡-琵琶腿',
  那么大鸡排椒盐风味: '那么大鸡排',
  阳光柠檬红茶: '阳光柠檬红茶中杯',
  玉米杯: '大杯玉米杯',
  可乐: '可乐中杯',
  雪碧: '雪碧中杯',
  鲜萃咖啡: '大杯鲜萃咖啡',
  燕麦奶: null,
  燕麦奶铁: '冰燕麦奶铁中杯',
  '麦咖啡™奶铁': '冰奶铁中杯',
  '麦咖啡™美式': '冰美式中杯',
  浓浓黑巧冰热: '热浓浓黑巧中杯',
  美禄可可雪冰: null,
  经典麦旋风: null, // 营养库只有奥利奥/草莓口味
  蓝莓爆爆珠麦旋风: null,
  '泷愿成真麦旋风——大米风味': null,
  '【美汁源】“黄金橙橙”': '【美汁源】“黄金橙橙”',
  '【美汁源】“多汁柠柠”': null,
  '怡泉+C': '中杯怡泉+C',
  牛奶: '热牛奶中杯',
  新地: '朱古力新地',
  马苏里拉拉丝芝士条: null,
  心形薯饼5块: '脆薯饼',
  蘸酱麦麦脆汁鸡: '麦麦脆汁鸡-琵琶腿',
  蘸酱炸鸡: '麦麦脆汁鸡-带骨里脊',
  韩式烟熏芝士风味酱: null,
  日式鲜磨山葵酱: null,
  '旋旋星愿贴': null,
  '“葱不求人“按摩捶痒痒挠': null,
};

/**
 * 主食类：汉堡本身在营养库里基本都有。套餐不单独给热量——
 * 套餐 = 主食 + 薯条 + 饮料，热量应当由组合累加，不能凭空给一个数。
 */
const SET_MEAL_HINT = /三件套|套餐|开心乐园餐|双人餐|精选|拼/;

/* ============================================================
 * 3. 主入口
 * ============================================================ */

/**
 * 把营养数据合并进菜单（不修改原对象）
 * @param {object} menu  normalizeMenu 之后的 { items, buckets }
 * @param {string} nutritionText  list-nutrition-foods 的 data 原文
 * @returns {{ items: object[], matched: number, total: number, missing: string[], assumed: string[] }}
 */
export function attachNutrition(menu, nutritionText) {
  const table = parseNutritionText(nutritionText);
  const missing = [];
  const assumed = [];

  const items = menu.items.map((item) => {
    if (typeof item.kcal === 'number' && item.kcal > 0) return item;

    const key = item.name.replace(/\s/g, '');
    const canonical = key.replace(/[（）()]/g, (m) => (m === '（' ? '(' : m === '）' ? ')' : m));

    // 1) 别名表
    let target = Object.prototype.hasOwnProperty.call(ALIAS, key) ? ALIAS[key] : key;
    if (target === undefined) target = key;

    // 2) 精确命中
    let hit = target && table.get(target);

    // 3) 套餐不给热量（由组合累加），零食/周边不参与
    if (!hit) {
      if (SET_MEAL_HINT.test(key)) {
        missing.push(item.name);
        return item;
      }
      // 4) 去掉"™""风味""口味"等修饰再试
      const cleaned = key.replace(/[™风味口味]/g, '');
      hit = table.get(cleaned) ?? table.get(cleaned.replace(/[()（）]/g, ''));
    }

    if (!hit) {
      missing.push(item.name);
      return item;
    }

    if (target !== key) assumed.push(`${item.name} → ${target}`);
    return { ...item, kcal: hit.kcal, kcalSource: target };
  });

  return {
    items,
    matched: items.filter((i) => typeof i.kcal === 'number' && i.kcal > 0).length,
    total: items.length,
    missing,
    assumed,
    declared: table.__declared ?? null,
  };
}
