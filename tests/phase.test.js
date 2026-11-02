// รัน: node tests/phase.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] }, localStorage: {}, setInterval() {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'phase.js'), 'utf8'), sandbox);
const T = sandbox.window.PhaseUI._test;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
const row = (r, g, b, label) => ({ r, g, b, label: label || '' });
const hist = (...reds) => reds.map(x => row(x * 100, (1 - x) * 50, (1 - x) * 50)); // redness = x

t('redness: ปกติ', () => close(T.redness(50, 25, 25), 0.5));
t('redness: หารศูนย์ -> null', () => assert.strictEqual(T.redness(0, 0, 0), null));
t('redness: ค่าว่าง/ไม่ใช่ตัวเลข -> null', () => {
  assert.strictEqual(T.redness(null, 1, 1), null);
  assert.strictEqual(T.redness(undefined, undefined, undefined), null);
  assert.strictEqual(T.redness('abc', 1, 1), null);
});
t('hue: แดง/เขียว/น้ำเงิน/เทา/ศูนย์', () => {
  assert.strictEqual(T.hue(255, 0, 0), 0);
  assert.strictEqual(T.hue(0, 255, 0), 120);
  assert.strictEqual(T.hue(0, 0, 255), 240);
  assert.strictEqual(T.hue(80, 80, 80), 0);
  assert.strictEqual(T.hue(0, 0, 0), null);
  assert.ok(T.hue(255, 0, 10) > 340);
});
t('median: ข้อมูลว่าง -> null', () => {
  assert.strictEqual(T.median([]), null);
  assert.strictEqual(T.median(undefined), null);
  assert.strictEqual(T.median([null, 'x']), null);
});
t('median: คี่/คู่/ไม่เรียง', () => {
  assert.strictEqual(T.median([3, 1, 2]), 2);
  assert.strictEqual(T.median([4, 1, 3, 2]), 2.5);
});
t('swatchColor: ปรับตาม c และกันหารศูนย์', () => {
  assert.strictEqual(JSON.stringify(T.swatchColor(200, 100, 50, 400)), JSON.stringify([255, 128, 64]));
  assert.strictEqual(JSON.stringify(T.swatchColor(10, 5, 0, 0)), JSON.stringify([255, 128, 0]));
  assert.strictEqual(T.swatchColor(0, 0, 0, 0), null);
  assert.strictEqual(T.swatchColor(null, 1, 1, 1), null);
});
t('phaseByTime: ขอบเขตวัน 0-2/3-5/6-15/หลัง 15', () => {
  [[0, 1], [2, 1], [2.9, 1], [3, 2], [5.9, 2], [6, 3], [15.9, 3], [16, 4], [100, 4], [-1, 1]]
    .forEach(([d, p]) => assert.strictEqual(T.phaseByTime(d), p, 'day ' + d));
});
t('phaseByTime: ใช้ช่วงวันที่ปรับเอง', () => assert.strictEqual(T.phaseByTime(4, { p1End: 4, p2End: 8, p3End: 20 }), 1));
t('validCfg', () => {
  assert.ok(T.validCfg({ p1End: 2, p2End: 5, p3End: 15 }));
  assert.ok(!T.validCfg({ p1End: 5, p2End: 5, p3End: 15 }));
  assert.ok(!T.validCfg({ p1End: 2, p2End: 5, p3End: 1.5 }));
  assert.ok(!T.validCfg(null));
});
t('trendOf: ข้อมูลว่าง/น้อย -> stable null', () => {
  assert.strictEqual(T.trendOf([]).stable, null);
  assert.strictEqual(T.trendOf(hist(0.5, 0.5)).stable, null);
});
t('trendOf: สีนิ่ง (<2%) และไม่นิ่ง', () => {
  assert.strictEqual(T.trendOf(hist(0.50, 0.505, 0.51, 0.505, 0.5, 0.51)).stable, true);
  assert.strictEqual(T.trendOf(hist(0.30, 0.35, 0.40, 0.45, 0.50, 0.55)).stable, false);
});
t('trendOf: ใช้เฉพาะ 6 ค่าล่าสุด', () => {
  const tr = T.trendOf(hist(0.1, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5));
  assert.strictEqual(tr.stable, true);
  assert.strictEqual(tr.n, 6);
});
t('isFaded: ซีดเกิน 15% จากค่าสูงสุด', () => {
  assert.strictEqual(T.isFaded(hist(0.4, 0.5, 0.6), 0.5), true);   // 0.5 < 0.6*0.85=0.51
  assert.strictEqual(T.isFaded(hist(0.4, 0.5, 0.6), 0.52), false);
});
t('isFaded: ตัวอย่างน้อย/ว่าง -> false', () => {
  assert.strictEqual(T.isFaded([], null), false);
  assert.strictEqual(T.isFaded(hist(0.6), 0.2), false);
});
t('labelMedians: ข้ามป้ายที่ไม่รู้จักและแถวไม่มีสี', () => {
  const m = T.labelMedians([row(60, 20, 20, 'แดง'), row(80, 10, 10, 'แดง'), row(0, 0, 0, 'แดง'), row(1, 1, 1, 'อื่น'), row(1, 1, 1, '')]);
  assert.deepStrictEqual(Object.keys(m), ['แดง']);
  assert.strictEqual(m['แดง'].n, 2);
  close(m['แดง'].median, (0.6 + 0.8) / 2);
});
t('determinePhase: ไม่มีรอบ -> none', () => {
  assert.strictEqual(T.determinePhase({}).phase, null);
  assert.strictEqual(T.determinePhase({ days: null }).mode, 'none');
  assert.strictEqual(T.determinePhase().phase, null);
});
t('determinePhase: โหมดเวลา ไม่มีข้อมูลสี (ข้อมูลว่าง)', () => {
  const r = T.determinePhase({ days: 1, redness: null, history: [], labelRows: [], cfg: T.DEFAULT_CFG });
  assert.strictEqual(r.mode, 'time');
  assert.strictEqual(r.phase, 1);
  assert.strictEqual(T.determinePhase({ days: 4, redness: null }).phase, 2);
  assert.strictEqual(T.determinePhase({ days: 10, redness: null }).phase, 3);
  assert.strictEqual(T.determinePhase({ days: 20, redness: null }).phase, 4);
});
t('determinePhase: เฟส 5 ตัดสินจากสีเท่านั้น (สีซีดในโหมดเวลา)', () => {
  const h = hist(0.4, 0.5, 0.6, 0.6);
  assert.strictEqual(T.determinePhase({ days: 20, redness: 0.45, history: h }).phase, 5);
  assert.strictEqual(T.determinePhase({ days: 20, redness: 0.58, history: h }).phase, 4);
  // เวลาไม่ถึงเฟส 3 ต่อให้สีซีดก็ไม่เป็นเฟส 5
  assert.strictEqual(T.determinePhase({ days: 1, redness: 0.45, history: h }).phase, 1);
});
t('determinePhase: โหมดปรับเทียบ — ป้ายใกล้สุด', () => {
  const labels = [row(40, 30, 30, 'ชมพูอ่อน'), row(40, 30, 30, 'ชมพูอ่อน'), row(60, 20, 20, 'แดง'), row(80, 10, 10, 'แดงเข้ม/พร้อมใช้')];
  const base = { days: 1, history: [], labelRows: labels };
  assert.strictEqual(T.determinePhase({ ...base, redness: 0.41 }).phase, 1);
  const r = T.determinePhase({ ...base, redness: 0.62 });
  assert.strictEqual(r.phase, 2);
  assert.strictEqual(r.mode, 'calibrated');
  assert.strictEqual(r.nearest, 'แดง');
});
t('determinePhase: ป้ายไม่พอ -> กลับไปโหมดเวลา', () => {
  const r = T.determinePhase({ days: 7, redness: 0.5, history: [], labelRows: [row(60, 20, 20, 'แดง'), row(60, 20, 20, 'แดง'), row(60, 20, 20, 'แดง')] });
  assert.strictEqual(r.mode, 'time');
});
t('determinePhase: ปรับเทียบ + สีนิ่ง ใกล้พร้อมใช้ -> เฟส 4', () => {
  const labels = [row(60, 20, 20, 'แดง'), row(60, 20, 20, 'แดง'), row(80, 10, 10, 'แดงเข้ม/พร้อมใช้')];
  const stable = hist(0.80, 0.805, 0.80, 0.795, 0.80, 0.80);
  const moving = hist(0.60, 0.65, 0.70, 0.75, 0.78, 0.80);
  assert.strictEqual(T.determinePhase({ days: 8, redness: 0.80, history: stable, labelRows: labels }).phase, 4);
  assert.strictEqual(T.determinePhase({ days: 8, redness: 0.80, history: moving, labelRows: labels }).phase, 3);
});
t('determinePhase: ปรับเทียบ ใกล้ป้ายซีด -> เฟส 5', () => {
  const labels = [row(80, 10, 10, 'แดงเข้ม/พร้อมใช้'), row(80, 10, 10, 'แดงเข้ม/พร้อมใช้'), row(35, 32, 33, 'ซีด/ผิดปกติ')];
  assert.strictEqual(T.determinePhase({ days: 12, redness: 0.36, history: [], labelRows: labels }).phase, 5);
});
t('fmtElapsed', () => {
  assert.strictEqual(T.fmtElapsed(0), '0 วัน 0 ชั่วโมง');
  assert.strictEqual(T.fmtElapsed(26 * 3600000), '1 วัน 2 ชั่วโมง');
  assert.strictEqual(T.fmtElapsed(-5), '-');
});

console.log('\n' + n + ' tests passed');
