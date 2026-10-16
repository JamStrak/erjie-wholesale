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
    customerName: '当时的客户', note: '报价快照', status: '待确认', retail: 59, basePrice: 45,
    input: { quantity: 20, unitPrice: 39, purchaseCost: 22, packagingCost: 1,
      shippingCost: 15, inboundCost: 8, otherCost: 2, customerShipping: 0,
      feeRate: 0, targetMargin: 25 },
    result: {},
  };
}

function oldDemoData() {
  return {...demoData(),products:[
    {id:'demo-bag',name:'日常帆布托特包',category:'包包',cost:22,wholesalePrice:30,retail:59,packaging:1,supplier:'示例厂家 A',note:'这是练习商品，价格仅用于演示。',tiers:[{minQty:50,cost:20},{minQty:100,cost:18}]},
    {id:'demo-hat',name:'百搭软檐棒球帽',category:'帽子',cost:12,wholesalePrice:18,retail:35,packaging:0.5,supplier:'示例厂家 B',note:'这是练习商品，价格仅用于演示。',tiers:[{minQty:50,cost:10.5}]}
  ]};
}

function legacyData() {
  const data = oldDemoData();
  data.version = 1;
  for (const p of data.products) delete p.wholesalePrice;
  for (const c of data.customers) {
    delete c.productDiscounts;
    c.discount = 8;
    c.productPrices = { 'demo-bag': 30, 'removed-product': 0 };
  }
  const quote = quotation(); delete quote.basePrice;
  quote.result = { profit: 222, annotation: '历史原值' };
  data.quotes.push(quote);
  return data;
}

test('first use contains the current two editable product examples without writing storage', () => {
  const storage = memoryStorage();
  const data = readData(storage);
  assert.equal(data.demo, true);
  assert.equal(data.products.length, 2);
  assert.equal(data.customers.length, 1);
  assert.equal(data.quotes.length, 0);
  assert.equal(data.version, 2);
  assert.deepEqual(data.products.map(p => p.name), ['发财包', '鸭舌帽']);
  assert.deepEqual(data.products.map(p => p.cost), [10, 8]);
  assert.deepEqual(data.products.map(p => p.wholesalePrice), [15, 11]);
  assert.deepEqual(data.products.map(p => p.retail), [29, 35]);
  assert.deepEqual(data.products.map(p => p.packaging), [0.5, 0.5]);
  assert.deepEqual(data.products.map(p => p.tiers), [[], []]);
  for (const quantity of [1, 50, 100]) {
    assert.deepEqual(data.products.map(p => getPurchaseCost(p, quantity)), [10, 8]);
  }
  assert.equal(data.customers[0].discount, 9);
  assert.deepEqual(data.customers[0].productDiscounts, {});
  assert.match(data.customers[0].note, /50 件/);
  assert.match(data.products[0].note, /可.*修改/);
  assert.match(data.products[1].note, /35 元.*参考.*核实/);
  assert.match(data.customers[0].name, /示例/);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
  assert.deepEqual(storage.writes, []);
  assert.doesNotThrow(() => validateData(data));
});

test('reading old unchanged examples refreshes both products and preserves customer and quote snapshots', () => {
  for (const legacyWholesale of [false, true]) {
    const source = oldDemoData();
    source.demo = false;
    source.quotes.push(quotation());
    source.customers[0].productPrices = { 'demo-bag': 17 };
    source.customers[0].productDiscounts = { 'demo-bag': 8.5 };
    source.updatedAt = '2026-10-16T01:00:00.000Z';
    if (legacyWholesale) for (const product of source.products) product.wholesalePrice = null;
    const raw = JSON.stringify(source), storage = memoryStorage(raw), updated = readData(storage);
    assert.deepEqual(updated.products, demoData().products);
    assert.deepEqual(updated.customers, source.customers);
    assert.deepEqual(updated.quotes, source.quotes);
    assert.deepEqual(updated.settings, source.settings);
    assert.equal(updated.demo, source.demo);
    assert.equal(updated.updatedAt, source.updatedAt);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test('version 1 old examples refresh only when reading storage and keep all historical amounts', () => {
  const source = legacyData(), raw = JSON.stringify(source), storage = memoryStorage(raw);
  const updated = readData(storage), validated = validateData(source);
  assert.deepEqual(updated.products, demoData().products);
  assert.deepEqual(updated.customers, validated.customers);
  assert.deepEqual(updated.quotes, validated.quotes);
  assert.equal(updated.quotes[0].input.purchaseCost, 22);
  assert.equal(updated.quotes[0].input.unitPrice, 39);
  assert.equal(updated.quotes[0].result.profit, 222);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(storage.writes, []);
});

test('refresh never replaces edited or custom product records, including supplier, note and tiers', () => {
  const changes = [
    p => { p.id = 'my-bag'; }, p => { p.name = '自己的帆布包'; },
    p => { p.category = '其他'; }, p => { p.cost = 21; },
    p => { p.wholesalePrice = 31; }, p => { p.retail = 58; },
    p => { p.packaging = 0.8; }, p => { p.supplier = '真正的厂家'; },
    p => { p.note = '自己的记录'; }, p => { p.tiers[0].cost = 19; },
    p => { p.tiers[0].minQty = 51; }, p => { p.tiers = []; },
    p => { p.tiers.reverse(); }, p => { p.privateMetadata = 'keep'; },
    p => { p.tiers[0].note = 'keep'; },
  ];
  for (const change of changes) {
    const source = oldDemoData(); change(source.products[0]);
    const raw = JSON.stringify(source), storage = memoryStorage(raw), updated = readData(storage);
    assert.deepEqual(updated.products[0], source.products[0]);
    assert.deepEqual(updated.products[1], demoData().products[1]);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test('validating or restoring a backup never refreshes old examples', () => {
  const source = oldDemoData();
  assert.deepEqual(validateData(source), source);
  assert.deepEqual(parseBackup(JSON.stringify(source)), source);
  assert.deepEqual(parseBackup(backupText(source)), source);
  const legacy = legacyData(), migrated = validateData(legacy);
  assert.equal(migrated.products[0].name, '日常帆布托特包');
  assert.deepEqual(parseBackup(backupText(legacy)), migrated);
  assert.deepEqual(parseBackup(JSON.stringify(legacy)), migrated);
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
  copy.products[0].tiers.push({ minQty: 50, cost: 1 });
  copy.customers[0].productPrices['demo-bag'] = 30;
  copy.customers[0].productDiscounts['demo-bag'] = 7;
  copy.settings.targetMargin = 10;
  assert.deepEqual(source.products[0].tiers, []);
  assert.deepEqual(source.customers[0].productPrices, {});
  assert.deepEqual(source.customers[0].productDiscounts, {});
  assert.equal(source.settings.targetMargin, 25);
  assert.deepEqual(demoData().products[0].tiers, []);
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
  for (const raw of ['broken json', '{"version":2}', JSON.stringify({ ...emptyData(), version: 3 }), 'null']) {
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
  data.customers[0].productDiscounts['demo-bag'] = 8.5;
  data.quotes.push(quotation());
  const raw = backupText(data);
  assert.equal(JSON.parse(raw).app, '二姐批发小算盘');
  assert.deepEqual(parseBackup(raw), data);
  assert.deepEqual(parseBackup(JSON.stringify(data)), data);
});

test('version 1 migration preserves recorded amounts and never uses retail as a new discount base', () => {
  const source = legacyData(), original = structuredClone(source);
  const migrated = validateData(source);
  assert.deepEqual(source, original);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.products.map(p => p.wholesalePrice), [null, null]);
  for (let i = 0; i < source.products.length; i++) {
    const { wholesalePrice, ...recorded } = migrated.products[i];
    assert.deepEqual(recorded, source.products[i]);
  }
  assert.equal(migrated.customers[0].discount, 8);
  assert.deepEqual(migrated.customers[0].productPrices, source.customers[0].productPrices);
  assert.deepEqual(migrated.customers[0].productDiscounts, { 'demo-bag': 10, 'removed-product': 10 });
  const { basePrice, ...quote } = migrated.quotes[0];
  assert.equal(basePrice, null);
  assert.deepEqual(quote, source.quotes[0]);
  migrated.quotes[0].input.unitPrice = 1;
  migrated.customers[0].productPrices['demo-bag'] = 1;
  assert.deepEqual(source, original);
});

test('reading legacy data migrates only the returned clone and writes no storage', () => {
  const source = legacyData(), raw = JSON.stringify(source), storage = memoryStorage(raw);
  const migrated = readData(storage);
  assert.equal(migrated.version, 2);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(storage.writes, []);
  const saved = writeData(migrated, storage);
  assert.equal(saved.version, 2);
  assert.equal(STORAGE_KEY, 'erjie-wholesale-v1');
  assert.deepEqual(readData(storage), saved);
  assert.equal(storage.writes.length, 1);
});

test('legacy wrapped and raw backups migrate identically and round trip as version 2', () => {
  const source = legacyData(), expected = validateData(source);
  assert.deepEqual(parseBackup(backupText(source)), expected);
  assert.deepEqual(parseBackup(JSON.stringify(source)), expected);
  assert.deepEqual(parseBackup(backupText(expected)), expected);
  assert.deepEqual(validateData(expected), expected);
});

test('invalid legacy data fails before migration and cannot replace stored data', () => {
  const source = legacyData(); source.customers[0].productPrices['demo-bag'] = -1;
  const raw = JSON.stringify(source), storage = memoryStorage(raw);
  assert.throws(() => readData(storage), /客户专属价格/);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(storage.writes, []);
  assert.throws(() => parseBackup(backupText(source)), /客户专属价格/);
});

test('unset wholesale bases and quote bases stay explicitly null without retail fallback', () => {
  const data = demoData();
  data.products[0].wholesalePrice = null;
  const quote = quotation(); quote.basePrice = null; data.quotes.push(quote);
  const restored = parseBackup(backupText(data));
  assert.equal(restored.products[0].wholesalePrice, null);
  assert.equal(restored.products[0].retail, 29);
  assert.equal(restored.quotes[0].basePrice, null);
  assert.deepEqual(restored.quotes[0].input, quote.input);
});

test('per-product discount supports free, full and fractional discounts independently of special prices', () => {
  for (const discount of [0, 0.01, 8.55, 10]) {
    const data = demoData();
    data.customers[0].productDiscounts['demo-bag'] = discount;
    const restored = parseBackup(backupText(data));
    assert.equal(restored.customers[0].productDiscounts['demo-bag'], discount);
    assert.equal(restored.customers[0].discount, 9);
    assert.deepEqual(restored.customers[0].productPrices, {});
  }
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
    d => { delete d.products[0].wholesalePrice; },
    d => { d.products[0].wholesalePrice = -1; },
    d => { d.products[0].wholesalePrice = '30'; },
    d => { d.products[0].name = '  '; },
    d => { d.products.push(structuredClone(d.products[0])); },
    d => { d.customers[0].discount = 10.1; },
    d => { d.customers[0].discount = -1; },
    d => { d.customers[0].productPrices['demo-bag'] = 10.005; },
    d => { delete d.customers[0].productDiscounts; },
    d => { d.customers[0].productDiscounts = null; },
    d => { d.customers[0].productDiscounts = []; },
    d => { d.customers[0].productDiscounts['demo-bag'] = -1; },
    d => { d.customers[0].productDiscounts['demo-bag'] = 10.01; },
    d => { d.customers[0].productDiscounts['demo-bag'] = '9'; },
    d => { d.customers[0].productDiscounts['demo-bag'] = Infinity; },
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
    const data = demoData(); data.products[0].tiers.push({ minQty: 50, cost: 10 }, tier);
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
    q => { delete q.basePrice; }, q => { q.basePrice = -1; },
    q => { q.basePrice = '45'; }, q => { q.basePrice = Infinity; },
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
    d => { d.products[0].wholesalePrice = 30.000000001; },
    d => { d.products[0].packaging = 1.000000001; },
    d => { d.products[0].tiers.push({ minQty: 50, cost: 20.000000001 }); },
    d => { d.customers[0].productPrices['demo-bag'] = 39.000000001; },
    d => { d.quotes[0].retail = 59.000000001; },
    d => { d.quotes[0].basePrice = 45.000000001; },
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
    d => { d.customers[0].productDiscounts['demo-bag'] = 8.001; },
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
    data.products[0].wholesalePrice = value;
    data.products[0].tiers.push({ minQty: 50, cost: value });
    data.customers[0].discount = 8.55;
    data.customers[0].productPrices['demo-bag'] = value;
    data.customers[0].productDiscounts['demo-bag'] = 8.55;
    data.settings.targetMargin = 25.12;
    quote.input.purchaseCost = value;
    quote.basePrice = value;
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
