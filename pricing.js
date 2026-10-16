/**
 * 所有成本均以人民币元输入。包装费按件，其余三项费用按整单。
 * 客户支付的运费计入实收；手续费对含运费的全部实收收取。
 * 金额和百分比最多两位小数，内部以整数分和万分比计算。
 */
const MAX_AMOUNT = 1_000_000;
const RATE_BASE = 10_000n;

function decimal(value, name, maximum = MAX_AMOUNT) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name}请填写数字`);
  }
  if (typeof value === 'string') {
    value = value.trim();
    if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
      throw new Error(`${name}须为非负数字，最多保留两位小数`);
    }
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > maximum) {
    throw new Error(`${name}须在 0 到 ${maximum} 之间`);
  }
  const scaled = numeric * 100;
  const rounded = Math.round(scaled);
  const floatTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  if (Math.abs(scaled - rounded) > floatTolerance) {
    throw new Error(`${name}最多保留两位小数`);
  }
  return BigInt(rounded);
}

function quantityValue(value, name = '数量') {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name}请填写整数`);
  }
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new Error(`${name}须为 1 到 100000 的整数`);
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100_000) {
    throw new Error(`${name}须为 1 到 100000 的整数`);
  }
  return numeric;
}

function ceilPositive(numerator, denominator) {
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function yuan(cents) {
  return Number(cents) / 100;
}

function feeFor(revenue, feeRate) {
  // 非负金额按分四舍五入，精确处理恰好半分的情况。
  return (revenue * feeRate + 5_000n) / RATE_BASE;
}

export function calculateQuote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请填写完整的报价信息');
  }
  const quantity = quantityValue(input.quantity);
  const count = BigInt(quantity);
  const unitPrice = decimal(input.unitPrice, '单件售价');
  const purchaseCost = decimal(input.purchaseCost, '单件进价');
  const packagingCost = decimal(input.packagingCost, '单件包装费');
  const shippingCost = decimal(input.shippingCost, '本单发货运费');
  const inboundCost = decimal(input.inboundCost, '本单进货运费');
  const otherCost = decimal(input.otherCost, '本单其他费用');
  const customerShipping = decimal(input.customerShipping, '客户支付运费');
  const feeRate = decimal(input.feeRate, '手续费率', 99.99);
  const targetMargin = decimal(input.targetMargin, '目标利润率', 99.99);

  const goodsRevenue = unitPrice * count;
  const revenue = goodsRevenue + customerShipping;
  const purchaseTotal = purchaseCost * count;
  const packagingTotal = packagingCost * count;
  const fixedCost = shippingCost + inboundCost + otherCost;
  const operatingCost = purchaseTotal + packagingTotal + fixedCost;
  const fee = feeFor(revenue, feeRate);
  const totalCost = operatingCost + fee;
  const profit = revenue - totalCost;

  const profitAt = price => {
    const receipts = price * count + customerShipping;
    return receipts - operatingCost - feeFor(receipts, feeRate);
  };

  // 不亏的判定随售价单调变化；二分找到确实不亏的最小整数分售价。
  const netRate = RATE_BASE - feeRate;
  let lower = 0n;
  let upper = ceilPositive(
    operatingCost * RATE_BASE + 5_000n - customerShipping * netRate,
    count * netRate,
  );
  while (lower < upper) {
    const middle = (lower + upper) / 2n;
    if (profitAt(middle) >= 0n) upper = middle;
    else lower = middle + 1n;
  }

  let targetPrice = null;
  const targetNetRate = RATE_BASE - feeRate - targetMargin;
  if (targetNetRate > 0n) {
    // 先对连续公式向上取整，再按实际手续费复核；避免半分舍入后欠目标。
    let candidate = ceilPositive(
      operatingCost * RATE_BASE - customerShipping * targetNetRate,
      count * targetNetRate,
    );
    for (;;) {
      const receipts = candidate * count + customerShipping;
      const candidateProfit = receipts - operatingCost - feeFor(receipts, feeRate);
      const hasMargin = receipts > 0n || targetMargin === 0n;
      if (hasMargin && candidateProfit * RATE_BASE >= targetMargin * receipts) break;
      candidate += 1n;
    }
    targetPrice = yuan(candidate);
  }

  return {
    quantity,
    unitPrice: yuan(unitPrice),
    purchaseCost: yuan(purchaseCost),
    goodsRevenue: yuan(goodsRevenue),
    revenue: yuan(revenue),
    purchaseTotal: yuan(purchaseTotal),
    packagingTotal: yuan(packagingTotal),
    fixedCost: yuan(fixedCost),
    fee: yuan(fee),
    totalCost: yuan(totalCost),
    profit: yuan(profit),
    unitProfit: yuan(profit) / quantity,
    margin: revenue === 0n ? 0 : Number(profit) / Number(revenue) * 100,
    breakEvenPrice: yuan(lower),
    targetPrice,
  };
}

/** 达到的最高数量门槛进价适用于整单全部商品。不会修改传入的商品或阶梯。 */
export function getPurchaseCost(product, quantity) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw new Error('商品进价信息无效');
  }
  const count = quantityValue(quantity);
  let selectedCost = decimal(product.cost, '商品基础进价');
  let selectedMinimum = 0;
  const tiers = product.tiers === undefined ? [] : product.tiers;
  if (!Array.isArray(tiers)) throw new Error('阶梯进价须为列表');
  const thresholds = new Set();
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
      throw new Error('阶梯进价信息无效');
    }
    const minimum = quantityValue(tier.minQty, '阶梯起订量');
    const cost = decimal(tier.cost, '阶梯进价');
    if (thresholds.has(minimum)) throw new Error('阶梯起订量不能重复');
    thresholds.add(minimum);
    if (minimum <= count && minimum > selectedMinimum) {
      selectedMinimum = minimum;
      selectedCost = cost;
    }
  }
  return yuan(selectedCost);
}

export function formatMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('金额须为有效数字');
  }
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Object.is(value, -0) ? 0 : value);
}

/** 折扣以折前批发单价为基准，先将单件成交价按分四舍五入。 */
export function discountedPrice(basePrice, discount) {
  const price = decimal(basePrice, '折前单价');
  const rate = decimal(discount, '折扣', 10);
  return yuan((price * rate + 500n) / 1_000n);
}

/** 客户全部按建议零售价卖完时的空间，尚未扣除客户后续售卖费用。 */
export function calculateResale(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请填写完整的客户转售信息');
  }
  const quantity = quantityValue(input.quantity);
  const count = BigInt(quantity);
  const unitPrice = decimal(input.unitPrice, '客户拿货单价');
  const retail = decimal(input.retail, '建议零售价');
  const shippingCost = decimal(input.customerShipping, '客户支付运费');
  const revenue = retail * count;
  const goodsCost = unitPrice * count;
  const totalCost = goodsCost + shippingCost;
  const profit = revenue - totalCost;
  return {
    revenue: yuan(revenue),
    goodsCost: yuan(goodsCost),
    shippingCost: yuan(shippingCost),
    totalCost: yuan(totalCost),
    profit: yuan(profit),
    unitProfit: yuan(profit) / quantity,
    margin: revenue === 0n ? 0 : Number(profit) / Number(revenue) * 100,
  };
}

/** 客户商品专属折前价/折扣优先，缺少折前价时明确返回 null。 */
export function getCustomerPricing(product, customer) {
  if (!product || typeof product !== 'object' || Array.isArray(product)
      || typeof product.id !== 'string' || !product.id.trim()) {
    throw new Error('商品报价信息无效');
  }
  if (customer != null && (typeof customer !== 'object' || Array.isArray(customer))) {
    throw new Error('客户报价信息无效');
  }
  const readPrice = (map, name) => {
    if (map === undefined || map === null) return undefined;
    if (typeof map !== 'object' || Array.isArray(map)) throw new Error(`${name}须为商品价格表`);
    return Object.prototype.hasOwnProperty.call(map, product.id) ? map[product.id] : undefined;
  };
  const base = readPrice(customer?.productPrices, '客户商品单价') ?? product.wholesalePrice ?? null;
  const rate = readPrice(customer?.productDiscounts, '客户商品折扣') ?? customer?.discount ?? 10;
  const discount = yuan(decimal(rate, '客户折扣', 10));
  const basePrice = base === null ? null : yuan(decimal(base, '折前单价'));
  return {
    basePrice,
    discount,
    unitPrice: basePrice === null ? null : discountedPrice(basePrice, discount),
  };
}

export function discountLabel(unitPrice, basePrice) {
  const price = decimal(unitPrice, '单件售价');
  const regular = decimal(basePrice, '折前单价');
  if (regular === 0n) return '未设折前单价';
  if (price > regular) return '高于折前单价';
  const discount = Number(price) / Number(regular) * 10;
  return `${Number(discount.toFixed(2))}折`;
}
