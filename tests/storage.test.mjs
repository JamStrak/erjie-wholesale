import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, emptyData, demoData, validateData, readData, writeData,
  parseBackup, backupText, csvCell,
} from '../storage.js';
import { calculateQuote, getPurchaseCost } from '../pricing.js';

function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[STORAGE_KEY, initial]]);
  return {
    reads: [], writes: [],
    getItem(key) { this.reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { this.writes.push([key, value]); values.set(key, value); },
  };
}

function quotation() {
  return {
    id: 'quote-one', createdAt: '2026-10-16T01:00:00.000Z',
    productId: 'demo-bag', productName: '当时的包包', customerId: 'demo-customer',
    customerName: '当时的客户', note: '报价快照', status: '待确认', retail: 59,
    input: { quantity: 20, unitPrice: 39, purchaseCost: 22, packagingCost: 1,
      shippingCost: 15, inboundCost: 8, otherCost: 2, customerShipping: 0,
      feeRate: 0, targetMargin: 25 },
    result: {},
  };
}

test('first use returns clearly marked practice data without writing into storage', () => {
  const storage = memoryStorage();
  const data = readData(storage);
  assert.equal(data.demo, true);
  assert.equal(data.products.length, 2);
  assert.equal(data.customers.length, 1);
  assert.equal(data.quotes.length, 0);
  assert.match(data.products[0].note, /演示/);
  assert.match(data.customers[0].name, /示例/);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
  assert.deepEqual(storage.writes, []);
  assert.doesNotThrow(() => validateData(data));
});

test('empty formal data remains empty on reload and never gets demo records appended', () => {
  const source = emptyData();
  const storage = memoryStorage(JSON.stringify(source));
  assert.deepEqual(readData(storage), source);
  assert.equal(readData(storage).demo, false);
  assert.deepEqual(storage.writes, []);
});

test('demo, empty and validated objects do not share editable nested state', () => {
  const source = demoData();
  const copy = validateData(source);
  copy.products[0].tiers[0].cost = 1;
  copy.customers[0].productPrices['demo-bag'] = 30;
  copy.settings.targetMargin = 10;
  assert.equal(source.products[0].tiers[0].cost, 20);
  assert.deepEqual(source.customers[0].productPrices, {});
  assert.equal(source.settings.targetMargin, 25);
  assert.equal(demoData().products[0].tiers[0].cost, 20);
  assert.notEqual(emptyData().products, emptyData().products);
});

test('successful save writes only the independent storage key and returns a timestamped copy', () => {
  const data = demoData();
  const original = structuredClone(data);
  const storage = memoryStorage();
  const saved = writeData(data, storage);
  assert.deepEqual(data, original);
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.deepEqual(readData(storage), saved);
  assert.deepEqual(storage.writes.map(([key]) => key), [STORAGE_KEY]);
  assert.notEqual(STORAGE_KEY, 'erjie-vault-ledger-v1');
});

test('invalid save cannot replace previously stored data', () => {
  const raw = JSON.stringify(emptyData());
  const storage = memoryStorage(raw);
  const data = demoData();
  data.products[0].cost = -1;
  assert.throws(() => writeData(data, storage), /备份格式不正确/);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(storage.writes, []);
});

test('storage denial and quota errors surface instead of pretending to save', () => {
  const data = demoData();
  const original = structuredClone(data);
  assert.throws(() => readData({ getItem() { throw new Error('blocked'); } }), /blocked/);
  assert.throws(() => writeData(data, {
    setItem() { throw new Error('quota'); },
  }), /quota/);
  assert.deepEqual(data, original);
});

test('damaged or unsupported stored data is preserved and never reset automatically', () => {
  for (const raw of ['broken json', '{"version":2}', 'null']) {
    const storage = memoryStorage(raw);
    assert.throws(() => readData(storage));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test('full JSON export round trips products, private prices and quotation snapshots', () => {
  const data = demoData();
  data.demo = false;
  data.customers[0].productPrices['demo-bag'] = 37.25;
  data.quotes.push(quotation());
  const raw = backupText(data);
  assert.equal(JSON.parse(raw).app, '二姐批发小算盘');
  assert.deepEqual(parseBackup(raw), data);
  assert.deepEqual(parseBackup(JSON.stringify(data)), data);
});

test('malformed and oversized backups are rejected before being imported', () => {
  assert.throws(() => parseBackup('not json'), /有效的 JSON/);
  assert.throws(() => parseBackup(' '.repeat(15 * 1024 * 1024 + 1)), /15 MB/);
  for (const value of [null, [], {}, { version: 2 }, { data: {} }]) {
    assert.throws(() => parseBackup(JSON.stringify(value)));
  }
});

test('backup validation rejects invalid prices, impossible discounts and duplicate IDs', () => {
  const mutations = [
    d => { d.products[0].cost = -0.01; },
    d => { d.products[0].retail = 1.001; },
    d => { d.products[0].packaging = Infinity; },
    d => { d.products[0].cost = '22'; },
    d => { d.products[0].name = '  '; },
    d => { d.products.push(structuredClone(d.products[0])); },
    d => { d.customers[0].discount = 10.1; },
    d => { d.customers[0].discount = -1; },
    d => { d.customers[0].productPrices['demo-bag'] = 10.005; },
    d => { d.settings.targetMargin = 100; },
  ];
  for (const mutate of mutations) {
    const data = demoData(); mutate(data);
    assert.throws(() => validateData(data), /备份格式不正确/);
  }
});

test('procurement tiers reject duplicate thresholds, fractional quantities and negative costs', () => {
  for (const tier of [{ minQty: 50, cost: 19 }, { minQty: 2.5, cost: 19 },
    { minQty: 0, cost: 19 }, { minQty: 20, cost: -1 }]) {
    const data = demoData(); data.products[0].tiers.push(tier);
    assert.throws(() => validateData(data), /采购阶梯/);
  }
});

test('quotation inputs must contain complete, finite, cent-level costs and valid quantities', () => {
  const mutations = [
    q => { q.input.quantity = 0; }, q => { q.input.quantity = 1.5; },
    q => { q.input.unitPrice = NaN; }, q => { q.input.shippingCost = -1; },
    q => { delete q.input.inboundCost; }, q => { q.input.feeRate = 100; },
    q => { q.input.packagingCost = 0.001; }, q => { q.createdAt = 'yesterday'; },
    q => { q.status = 'wrong'; },
  ];
  for (const mutate of mutations) {
    const data = emptyData(), quote = quotation(); mutate(quote); data.quotes.push(quote);
    assert.throws(() => validateData(data), /备份格式不正确/);
  }
});

test('historical quotation snapshots survive removed products and customers', () => {
  const data = emptyData();
  data.quotes.push(quotation());
  assert.deepEqual(parseBackup(backupText(data)), data);
});

test('backup validation rejects sub-cent values that the pricing engine cannot calculate', () => {
  const mutations = [
    d => { d.products[0].cost = 22.000000001; },
    d => { d.products[0].retail = 59.000000001; },
    d => { d.products[0].packaging = 1.000000001; },
    d => { d.products[0].tiers[0].cost = 20.000000001; },
    d => { d.customers[0].productPrices['demo-bag'] = 39.000000001; },
    d => { d.quotes[0].retail = 59.000000001; },
    ...['unitPrice','purchaseCost','packagingCost','shippingCost','inboundCost','otherCost','customerShipping']
      .map(key => d => { d.quotes[0].input[key] = 1.000000001; }),
  ];
  for (const mutate of mutations) {
    const data = demoData(); data.quotes.push(quotation()); mutate(data);
    const raw = JSON.stringify(emptyData()), storage = memoryStorage(raw);
    assert.throws(() => parseBackup(backupText(data)), /备份格式不正确/);
    assert.throws(() => writeData(data, storage), /备份格式不正确/);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test('discounts and all saved percentage fields reject more than two decimal places', () => {
  const mutations = [
    d => { d.customers[0].discount = 8.001; },
    d => { d.settings.targetMargin = 25.001; },
    d => { d.quotes[0].input.feeRate = 0.001; },
    d => { d.quotes[0].input.targetMargin = 25.001; },
  ];
  for (const mutate of mutations) {
    const data = demoData(); data.quotes.push(quotation()); mutate(data);
    assert.throws(() => parseBackup(backupText(data)), /备份格式不正确/);
  }
});

test('valid cents and harmless floating-point noise remain usable after backup restore', () => {
  for (const value of [0, 0.01, 0.1 + 0.2, 0.29, 1.15, 22.01, 65535.99, 999999.99, 1000000]) {
    const data = demoData(), quote = quotation();
    data.products[0].cost = value;
    data.products[0].tiers[0].cost = value;
    data.customers[0].discount = 8.55;
    data.customers[0].productPrices['demo-bag'] = value;
    data.settings.targetMargin = 25.12;
    quote.input.purchaseCost = value;
    quote.input.feeRate = 0.1 + 0.2;
    quote.input.targetMargin = data.settings.targetMargin;
    data.quotes.push(quote);
    const restored = parseBackup(backupText(data));
    const rounded = Math.round(value * 100) / 100;
    assert.equal(getPurchaseCost(restored.products[0], 20), rounded);
    assert.equal(getPurchaseCost(restored.products[0], 50), rounded);
    assert.equal(calculateQuote(restored.quotes[0].input).purchaseCost, rounded);
    assert.equal(restored.settings.targetMargin, 25.12);
    assert.equal(restored.customers[0].discount, 8.55);
  }
});

test('CSV cells preserve commas, newlines, quotation marks and Chinese text', () => {
  assert.equal(csvCell('包包,帽子\n客户说"好"'), '"包包,帽子\n客户说""好"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(22.5), '"22.5"');
});

test('CSV cells neutralize spreadsheet formulas including leading whitespace', () => {
  for (const text of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', ' \t=1+1', '\r\n+1', '\uFEFF=1']) {
    assert.ok(csvCell(text).startsWith('"\''), `formula prefix not neutralized: ${JSON.stringify(text)}`);
  }
  assert.equal(csvCell('帽子=普通文字'), '"帽子=普通文字"');
});
