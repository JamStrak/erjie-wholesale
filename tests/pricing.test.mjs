import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, getPurchaseCost, formatMoney, discountLabel } from '../pricing.js';

const base = {
  quantity: 10,
  unitPrice: 25,
  purchaseCost: 12,
  packagingCost: 1,
  shippingCost: 15,
  inboundCost: 5,
  otherCost: 3,
  customerShipping: 8,
  feeRate: 0.6,
  targetMargin: 30,
};

test('成本、利润和客户运费采用一致口径，包装费随数量增加', () => {
  const result = calculateQuote(base);
  assert.equal(result.goodsRevenue, 250);
  assert.equal(result.revenue, 258);
  assert.equal(result.purchaseTotal, 120);
  assert.equal(result.packagingTotal, 10);
  assert.equal(result.fixedCost, 23);
  assert.equal(result.fee, 1.55);
  assert.equal(result.totalCost, 154.55);
  assert.equal(result.profit, 103.45);
  assert.equal(result.unitProfit, 10.345);
  assert.equal(result.margin, 103.45 / 258 * 100);
  assert.equal(result.breakEvenPrice, 14.6);
  assert.equal(result.targetPrice, 21.25);
});

test('客户运费也需要手续费，恰好半分时向上舍入', () => {
  const result = calculateQuote({ ...base, quantity: 1, unitPrice: 0.5, customerShipping: 0.5, feeRate: 0.5 });
  assert.equal(result.revenue, 1);
  assert.equal(result.fee, 0.01);
  assert.equal(calculateQuote({ ...base, quantity: 1, unitPrice: 0.49, customerShipping: 0.5, feeRate: 0.5 }).fee, 0);
});

test('大单折扣若低于成本，会明确呈现更大的亏损', () => {
  const quote = { ...base, unitPrice: 10, purchaseCost: 12, customerShipping: 0, feeRate: 0 };
  const small = calculateQuote({ ...quote, quantity: 10 });
  const large = calculateQuote({ ...quote, quantity: 1000 });
  assert.equal(small.profit, -53);
  assert.equal(large.profit, -3023);
  assert.ok(large.profit < small.profit);
  assert.ok(large.margin < 0);
});

test('客户运费足以覆盖所有成本时，不亏单价可以为零', () => {
  const result = calculateQuote({ ...base, customerShipping: 200 });
  assert.equal(result.breakEvenPrice, 0);
  assert.equal(calculateQuote({ ...base, unitPrice: 0, customerShipping: 200 }).profit, 45.8);
});

test('零收款没有百分比异常；正目标利润率需要实际正收款', () => {
  const zero = { ...base, quantity: 1, unitPrice: 0, purchaseCost: 0, packagingCost: 0, shippingCost: 0, inboundCost: 0, otherCost: 0, customerShipping: 0, feeRate: 0 };
  assert.equal(calculateQuote(zero).margin, 0);
  assert.equal(calculateQuote(zero).targetPrice, 0.01);
  assert.equal(calculateQuote({ ...zero, targetMargin: 0 }).targetPrice, 0);
});

test('目标利润率加手续费率达到或超过 100% 时无法建议目标价', () => {
  assert.equal(calculateQuote({ ...base, feeRate: 20, targetMargin: 80 }).targetPrice, null);
  assert.equal(calculateQuote({ ...base, feeRate: 20, targetMargin: 90 }).targetPrice, null);
});

test('目标价复核实际手续费，修复公式向上到分后仍欠目标的情况', () => {
  const quote = { ...base, quantity: 1, unitPrice: 0.03, purchaseCost: 0.01, packagingCost: 0, shippingCost: 0, inboundCost: 0, otherCost: 0, customerShipping: 0, feeRate: 50, targetMargin: 10 };
  const result = calculateQuote(quote);
  assert.equal(result.targetPrice, 0.04);
  assert.ok(calculateQuote({ ...quote, unitPrice: result.targetPrice }).margin >= 10);
  assert.ok(calculateQuote(quote).margin < 10);
});

test('极小净费率与最大金额仍能使用整数分精确计算', () => {
  const result = calculateQuote({ ...base, quantity: 100000, unitPrice: 1000000, purchaseCost: 1000000, packagingCost: 1000000, shippingCost: 1000000, inboundCost: 1000000, otherCost: 1000000, customerShipping: 1000000, feeRate: 99.99, targetMargin: 0 });
  assert.equal(result.goodsRevenue, 100000000000);
  assert.equal(result.revenue, 100001000000);
  assert.equal(result.fee, 99990999900);
  assert.equal(result.totalCost, 299993999900);
  assert.equal(result.profit, -199992999900);
  assert.ok(Number.isFinite(result.breakEvenPrice));
  assert.ok(Number.isFinite(result.targetPrice));
});

test('不亏单价与逐分穷举结果一致，目标价按实际利润率达标', () => {
  // 独立整数 oracle 穷举可验证手续费舍入导致的分界；不重复实现二分求价。
  const cases = [];
  for (const quantity of [1, 3, 17]) {
    for (const feeRate of [0, 0.5, 12.34, 50, 99.99]) {
      for (const customerShipping of [0, 0.02, 0.3]) {
        cases.push({ ...base, quantity, unitPrice: 0.2, purchaseCost: 0.03, packagingCost: 0.01, shippingCost: 0.03, inboundCost: 0, otherCost: 0, customerShipping, feeRate, targetMargin: feeRate < 50 ? 33.33 : 0 });
      }
    }
  }
  for (const quote of cases) {
    const result = calculateQuote(quote);
    const operatingCents = quote.quantity * 4 + 3;
    const shippingCents = Math.round(quote.customerShipping * 100);
    const basisPoints = Math.round(quote.feeRate * 100);
    const marginPoints = Math.round(quote.targetMargin * 100);
    const oracle = cents => {
      const revenueCents = cents * quote.quantity + shippingCents;
      const feeCents = Math.floor((revenueCents * basisPoints + 5000) / 10000);
      return { revenueCents, profitCents: revenueCents - operatingCents - feeCents };
    };
    let expectedCents = 0;
    while (oracle(expectedCents).profitCents < 0) expectedCents++;
    assert.equal(Math.round(result.breakEvenPrice * 100), expectedCents, JSON.stringify(quote));
    const target = oracle(Math.round(result.targetPrice * 100));
    assert.ok(target.profitCents * 10000 >= marginPoints * target.revenueCents, JSON.stringify(quote));
  }
});

test('无效输入直接报中文错误，不会把空白、null 或布尔值当作零', () => {
  for (const field of Object.keys(base)) {
    for (const value of ['', ' ', null, undefined, NaN, Infinity, -1, true, {}, []]) {
      assert.throws(() => calculateQuote({ ...base, [field]: value }), /[\u4e00-\u9fff]/, `${field}: ${String(value)}`);
    }
  }
  for (const value of [0, 1.5, 100001, '1.0']) assert.throws(() => calculateQuote({ ...base, quantity: value }));
  assert.throws(() => calculateQuote({ ...base, unitPrice: 0.001 }));
  assert.throws(() => calculateQuote({ ...base, unitPrice: 0.000000001 }));
  assert.throws(() => calculateQuote({ ...base, unitPrice: 1000000.01 }));
  assert.throws(() => calculateQuote({ ...base, feeRate: 100 }));
  assert.throws(() => calculateQuote({ ...base, targetMargin: 33.333 }));
  assert.throws(() => calculateQuote(null));
});

test('允许表单数字字符串与正常浮点表示误差', () => {
  const strings = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, String(value)]));
  assert.deepEqual(calculateQuote(strings), calculateQuote(base));
  assert.equal(calculateQuote({ ...base, unitPrice: 0.1 + 0.2 }).unitPrice, 0.3);
});

test('阶梯按最高达到门槛全量适用，不排序或修改源对象', () => {
  const product = Object.freeze({ cost: 20, tiers: Object.freeze([Object.freeze({ minQty: 100, cost: 12 }), Object.freeze({ minQty: 10, cost: 16 }), Object.freeze({ minQty: 50, cost: 14 })]) });
  assert.equal(getPurchaseCost(product, 9), 20);
  assert.equal(getPurchaseCost(product, 10), 16);
  assert.equal(getPurchaseCost(product, 49), 16);
  assert.equal(getPurchaseCost(product, 50), 14);
  assert.equal(getPurchaseCost(product, 99), 14);
  assert.equal(getPurchaseCost(product, 100), 12);
  assert.equal(getPurchaseCost(product, 100000), 12);
  assert.equal(getPurchaseCost({ cost: 20 }, 10), 20);
  assert.deepEqual(product.tiers.map(tier => tier.minQty), [100, 10, 50]);
});

test('阶梯拒绝无效或重复门槛，即使该阶梯尚未达到也要校验', () => {
  for (const product of [null, {}, { cost: '' }, { cost: 1, tiers: null }, { cost: 1, tiers: [null] }, { cost: 1, tiers: [{ minQty: 0, cost: 1 }] }, { cost: 1, tiers: [{ minQty: 100, cost: -1 }] }, { cost: 1, tiers: [{ minQty: 10, cost: 1 }, { minQty: 10, cost: 2 }] }]) {
    assert.throws(() => getPurchaseCost(product, 1), /[\u4e00-\u9fff]/);
  }
  assert.throws(() => getPurchaseCost({ cost: 1 }, ''));
});

test('价格展示、折扣与零售价边界', () => {
  assert.equal(formatMoney(1234.5), '1,234.50');
  assert.equal(formatMoney(-12), '-12.00');
  assert.equal(formatMoney(-0), '0.00');
  assert.throws(() => formatMoney(NaN));
  assert.equal(discountLabel(15, 20), '7.5折');
  assert.equal(discountLabel(20, 20), '10折');
  assert.equal(discountLabel(0, 20), '0折');
  assert.equal(discountLabel(20.01, 20), '高于零售价');
  assert.equal(discountLabel(15, 0), '未设零售价');
  assert.throws(() => discountLabel('', 20));
});
