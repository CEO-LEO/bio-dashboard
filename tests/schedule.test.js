// รัน: node tests/schedule.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null }, localStorage: { getItem: () => null }, setInterval() {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'schedule.js'), 'utf8'), sandbox);
const S = sandbox.window.ScheduleUI;
const T = S._test;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

t('CH_NAMES: 4 ช่อง ตรงกับที่ใช้ทั้งเว็บ', () => {
  assert.strictEqual(S.CH_NAMES.join('|'), 'ไฟ Grow Light|ปั๊ม Oxygen|อากาศออก|ปลั๊กเสริม (Aux)');
});
t('channelLabel: "CH n — ชื่อ"', () => {
  assert.strictEqual(S.channelLabel(1), 'CH 1 — ไฟ Grow Light');
  assert.strictEqual(S.channelLabel('2'), 'CH 2 — ปั๊ม Oxygen');
  assert.strictEqual(S.channelLabel(3), 'CH 3 — อากาศออก');
  assert.strictEqual(S.channelLabel(4), 'CH 4 — ปลั๊กเสริม (Aux)');
});
t('channelLabel: ช่องนอกช่วง -> CH n', () => {
  assert.strictEqual(S.channelLabel(0), 'CH 0');
  assert.strictEqual(S.channelLabel(9), 'CH 9');
});
t('controlledChannels: เฉพาะกฎที่เปิดใช้', () => {
  const rules = T.parse('2,I,180,10,1;1,D,360,1080,0;3,D,0,60,1;2,D,60,120,1;');
  assert.strictEqual(JSON.stringify(Object.keys(T.controlledChannels(rules))), JSON.stringify(['2', '3']));
});
t('controlledChannels: ว่าง/ไม่มีกฎ', () => {
  assert.strictEqual(Object.keys(T.controlledChannels([])).length, 0);
  assert.strictEqual(Object.keys(T.controlledChannels(undefined)).length, 0);
});
t('รูปแบบ schedule_text ไม่เปลี่ยน (parse/encode ย้อนกลับได้)', () => {
  const text = '2,I,180,10,1;1,D,360,1080,1;';
  assert.strictEqual(T.encode(T.parse(text)), text);
});

console.log('\n' + n + ' tests passed');
