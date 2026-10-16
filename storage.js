export const STORAGE_KEY = 'erjie-wholesale-v1';
export const uid = () => globalThis.crypto.randomUUID();
export function emptyData() { return {version:1,demo:false,products:[],customers:[],quotes:[],settings:{targetMargin:25},updatedAt:null}; }
export function demoData() {
  return { ...emptyData(),demo:true,products:[
    {id:'demo-bag',name:'日常帆布托特包',category:'包包',cost:22,retail:59,packaging:1,supplier:'示例厂家 A',note:'这是练习商品，价格仅用于演示。',tiers:[{minQty:50,cost:20},{minQty:100,cost:18}]},
    {id:'demo-hat',name:'百搭软檐棒球帽',category:'帽子',cost:12,retail:35,packaging:0.5,supplier:'示例厂家 B',note:'这是练习商品，价格仅用于演示。',tiers:[{minQty:50,cost:10.5}]}
  ],customers:[{id:'demo-customer',name:'示例客户 · 小林',contact:'抖音私信',discount:8,note:'练习用：首次拿货，先看 20 件的报价。',productPrices:{}}]};
}
function isObject(v) { return !!v && typeof v==='object' && !Array.isArray(v); }
function text(v,max=500) { return typeof v==='string' && v.length<=max; }
function num(v,min=0,max=1000000) { return typeof v==='number' && Number.isFinite(v) && v>=min && v<=max; }
function money(v,max=1000000) {
  if(!num(v,0,max))return false;
  const scaled=v*100;
  return Math.abs(scaled-Math.round(scaled))<=Number.EPSILON*Math.max(1,Math.abs(scaled))*4;
}
function fail(message) { throw new Error(`备份格式不正确：${message}`); }
function uniqueIds(rows,label) { const ids=new Set(); for(const x of rows) { if(!isObject(x)||!text(x.id,100)||!x.id||ids.has(x.id)) fail(`${label}编号重复或缺失`); ids.add(x.id); } }
export function validateData(value) {
  if(!isObject(value)||value.version!==1||typeof value.demo!=='boolean') fail('版本不支持');
  for(const key of ['products','customers','quotes']) if(!Array.isArray(value[key])||value[key].length>20000) fail(`${key}内容不完整或过大`);
  for(const [key,label] of [['products','商品'],['customers','客户'],['quotes','报价']]) uniqueIds(value[key],label);
  for(const p of value.products) {
    if(!text(p.name,100)||!p.name.trim()||!text(p.category,30)||!money(p.cost)||!money(p.retail)||!money(p.packaging)||!text(p.supplier,100)||!text(p.note,1000)||!Array.isArray(p.tiers)||p.tiers.length>50) fail('商品信息有误');
    const mins=new Set();for(const t of p.tiers) {if(!isObject(t)||!Number.isInteger(t.minQty)||!num(t.minQty,1,100000)||!money(t.cost)||mins.has(t.minQty))fail('采购阶梯有误');mins.add(t.minQty);}
  }
  for(const c of value.customers) {
    if(!text(c.name,100)||!c.name.trim()||!text(c.contact,150)||!money(c.discount,10)||!text(c.note,1000)||!isObject(c.productPrices)) fail('客户信息有误');
    if(Object.values(c.productPrices).some(v=>!money(v))) fail('客户专属价格有误');
  }
  for(const q of value.quotes) {
    if(!text(q.createdAt,50)||!Number.isFinite(Date.parse(q.createdAt))||!text(q.productName,100)||!text(q.customerName,100)||!text(q.productId,100)||!text(q.customerId,100)||!text(q.note,1000)||!['待确认','已接受','未成交'].includes(q.status)||!isObject(q.input)||!isObject(q.result)||!money(q.retail)) fail('报价信息有误');
    if(!Number.isInteger(q.input.quantity)||!num(q.input.quantity,1,100000)) fail('报价数量有误');
    for(const k of ['unitPrice','purchaseCost','packagingCost','shippingCost','inboundCost','otherCost','customerShipping']) if(!money(q.input[k])) fail('报价金额有误');
    for(const k of ['feeRate','targetMargin']) if(!money(q.input[k],99.99)) fail('报价百分比有误');
    // Results are recomputed by the application; never trust an imported profit.
  }
  if(!isObject(value.settings)||!money(value.settings.targetMargin,99.99)) fail('利润目标有误');
  return structuredClone(value);
}
export function readData(storage=globalThis.localStorage) {
  const raw=storage.getItem(STORAGE_KEY);
  return raw===null ? demoData() : validateData(JSON.parse(raw));
}
export function writeData(data,storage=globalThis.localStorage) {
  const valid=validateData(data);valid.updatedAt=new Date().toISOString();
  storage.setItem(STORAGE_KEY,JSON.stringify(valid));return valid;
}
export function parseBackup(raw) {
  if(raw.length>15*1024*1024) throw new Error('备份文件太大，请选择 15 MB 以内的 JSON 文件。');
  let v;try {v=JSON.parse(raw);}catch {throw new Error('文件不是有效的 JSON 备份，请重新选择。');}
  return validateData(isObject(v) ? (v.data ?? v) : v);
}
export function backupText(data) {return JSON.stringify({app:'二姐批发小算盘',exportedAt:new Date().toISOString(),data},null,2);}
export function csvCell(value) {
  let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s)) s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
}
