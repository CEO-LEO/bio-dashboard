// รัน: node tests/profiles.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, extra) {
  const sb = Object.assign({ window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setInterval() {}, console }, extra || {});
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sb);
  return sb;
}
const S = load('schedule.js').window.ScheduleUI;
const P = load('profiles.js').window.ProfileUI._test;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }
const round = (a) => JSON.parse(JSON.stringify(a));

t('มีสูตรครบ 4 แบบ ตามลำดับ', () => assert.strictEqual(P.ORDER.join(','), 'psb,chlorella,moina,haematococcus'));
t('ทุกสูตร: ระยะแรกเริ่มวัน 0 และวันเริ่มระยะเรียงจากน้อยไปมาก', () => {
  P.ORDER.forEach(id => {
    const st = P.PROFILES[id].stages;
    assert.strictEqual(st[0].fromDay, 0, id);
    for (let i = 1; i < st.length; i++) assert.ok(st[i].fromDay > st[i - 1].fromDay, id);
  });
});
t('ทุกสูตร/ระยะ/ตัวเลือกหลอดเสริม: กฎผ่าน ScheduleUI.parse ครบและไม่เกิน 16 กฎ (รูปแบบเดียวกับบอร์ด)', () => {
  P.ORDER.forEach(id => {
    const p = P.PROFILES[id];
    p.stages.forEach((_, i) => [false, true].forEach(extra => {
      const rules = P.rulesFor(p, i, { extraLamp: extra });
      const text = S._test.encode(rules);
      const back = S._test.parse(text);
      assert.strictEqual(back.length, rules.length, id + ' stage ' + i);
      assert.strictEqual(JSON.stringify(back), JSON.stringify(round(rules)), id + ' stage ' + i);
      assert.ok(rules.length <= 16);
      rules.forEach(r => assert.ok(r.ch >= 1 && r.ch <= 4));
    }));
  });
});
t('เปิดตลอด (I,1440,1440) ทำงานทุกนาทีตามตรรกะ isActive', () => {
  const r = { ch: 1, type: 'I', p1: 1440, p2: 1440, en: 1 };
  [0, 1, 719, 1439, 1440, 123456789].forEach(m => assert.strictEqual(S._test.isActive(r, m), true));
});
t('ช่วงอุณหภูมิถูกต้อง (ต่ำสุด < สูงสุด)', () => {
  P.ORDER.forEach(id => P.PROFILES[id].stages.forEach(s => assert.ok(s.temp[0] < s.temp[1], id)));
});
t('stageAt: ขอบเขตวันของ Haematococcus (0/10/24)', () => {
  const h = P.PROFILES.haematococcus;
  [[0, 0], [9.9, 0], [10, 1], [23.9, 1], [24, 2], [100, 2], [-3, 0], [null, 0], [NaN, 0]]
    .forEach(([d, i]) => assert.strictEqual(P.stageAt(h, d), i, 'day ' + d));
});
t('stageAt: สูตรระยะเดียวได้ระยะ 0 เสมอ', () => assert.strictEqual(P.stageAt(P.PROFILES.psb, 500), 0));
t('stageAt: ใช้วันที่ผู้ใช้ปรับเอง', () => assert.strictEqual(P.stageAt(P.PROFILES.haematococcus, 12, [0, 14, 30]), 0));
t('tempStatus: ต่ำ/พอดี/สูง/ขอบ/ไม่มีค่า', () => {
  const band = [30, 35];
  assert.strictEqual(P.tempStatus(band, 29.9), 'low');
  assert.strictEqual(P.tempStatus(band, 30), 'ok');
  assert.strictEqual(P.tempStatus(band, 35), 'ok');
  assert.strictEqual(P.tempStatus(band, 35.1), 'high');
  assert.strictEqual(P.tempStatus(band, null), null);
  assert.strictEqual(P.tempStatus(band, NaN), null);
  assert.strictEqual(P.tempStatus(null, 30), null);
});
t('rulesFor: หลอดเสริม CH 4 เพิ่มเฉพาะเมื่อเลือก และเฉพาะระยะที่กำหนด', () => {
  const h = P.PROFILES.haematococcus;
  assert.ok(!P.rulesFor(h, 1, { extraLamp: false }).some(r => r.ch === 4));
  assert.ok(P.rulesFor(h, 1, { extraLamp: true }).some(r => r.ch === 4));
  assert.ok(!P.rulesFor(h, 0, { extraLamp: true }).some(r => r.ch === 4));
  assert.strictEqual(P.rulesFor(h, 99, {}).length, 0);
});
t('rulesFor: คืนสำเนา แก้แล้วไม่กระทบข้อมูลสูตร', () => {
  const r = P.rulesFor(P.PROFILES.psb, 0, {});
  r[0].p1 = 999;
  assert.notStrictEqual(P.rulesFor(P.PROFILES.psb, 0, {})[0].p1, 999);
});
t('validDays', () => {
  const h = P.PROFILES.haematococcus;
  assert.ok(P.validDays(h, [0, 10, 24]));
  assert.ok(!P.validDays(h, [0, 24, 10]));
  assert.ok(!P.validDays(h, [1, 10, 24]));
  assert.ok(!P.validDays(h, [0, 10]));
  assert.ok(!P.validDays(h, [0, 10, 400]));
  assert.ok(!P.validDays(h, [0, 10.5, 24]));
});
t('daysSince', () => {
  const now = Date.UTC(2026, 10, 9, 0, 0, 0);
  assert.strictEqual(P.daysSince('2026-11-07T00:00:00Z', now), 2);
  assert.strictEqual(P.daysSince('2026-11-10T00:00:00Z', now), 0); // อนาคต -> 0
  assert.strictEqual(P.daysSince('bad', now), null);
});

// ---- ScheduleUI.replaceRules / getRules ----
t('replaceRules: กฎที่ไม่ผ่านการตรวจ -> คืน false และไม่แก้ตาราง', () => {
  const sb = load('schedule.js');
  const U = sb.window.ScheduleUI;
  assert.strictEqual(U.replaceRules([{ ch: 9, type: 'D', p1: 0, p2: 60, en: 1 }]), false);
  assert.strictEqual(U.getRules().length, 0);
});
t('replaceRules: กฎถูกต้อง -> แทนที่ทั้งหมด และ getRules คืนสำเนา', () => {
  const sb = load('schedule.js');
  const U = sb.window.ScheduleUI;
  assert.strictEqual(U.replaceRules(P.rulesFor(P.PROFILES.haematococcus, 0, {})), true);
  assert.strictEqual(U.getRules().length, 2);
  U.getRules()[0].p1 = 5;
  assert.notStrictEqual(U.getRules()[0].p1, 5);
});

console.log('\n' + n + ' tests passed');
