// รัน: node tests/presence.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null }, setInterval() {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'presence.js'), 'utf8'), sandbox);
const T = sandbox.window.PresenceUI._test;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const st = (iso) => T.presenceOf(iso, NOW).status;

t('ขอบเขต 3 นาที: 180 วิ ยังออนไลน์, 181 วิ เป็นช้า', () => {
  assert.strictEqual(st(ago(0)), 'online');
  assert.strictEqual(st(ago(179)), 'online');
  assert.strictEqual(st(ago(180)), 'online');
  assert.strictEqual(st(ago(181)), 'slow');
});
t('ขอบเขต 10 นาที: 600 วิ ยังช้า, 601 วิ เป็นออฟไลน์', () => {
  assert.strictEqual(st(ago(600)), 'slow');
  assert.strictEqual(st(ago(601)), 'offline');
  assert.strictEqual(st(ago(86400)), 'offline');
});
t('ageSec ถูกต้อง', () => assert.strictEqual(T.presenceOf(ago(125), NOW).ageSec, 125));
t('last_seen_at เป็น null/undefined/ว่าง -> ยังไม่เคยเห็น (ไม่ใช่ออฟไลน์)', () => {
  assert.strictEqual(st(null), 'never');
  assert.strictEqual(st(undefined), 'never');
  assert.strictEqual(st(''), 'never');
  assert.strictEqual(T.presenceOf(null, NOW).ageSec, null);
});
t('last_seen_at ใหม่ -> ออนไลน์ / เก่า -> ออฟไลน์', () => {
  assert.strictEqual(st(ago(10)), 'online');
  assert.strictEqual(st(ago(3 * 3600)), 'offline');
});
t('updated_at ใหม่แต่ last_seen_at เก่า -> ออฟไลน์ (ฟังก์ชันเห็นเฉพาะ last_seen_at)', () => {
  const dev = { updated_at: ago(2), last_seen_at: ago(1800) };
  assert.strictEqual(st(dev.last_seen_at), 'offline');
  assert.strictEqual(T.presenceOf(dev.last_seen_at, NOW).ageSec, 1800);
});
t('onCloudData ไม่ใช้ updated_at ตัดสินสถานะ (ทดสอบผ่าน DOM จำลอง)', () => {
  function run(dev) {
    const els = {};
    ['presenceBadge', 'presenceLabel', 'presenceAge', 'presenceStaleBanner', 'presenceStaleText'].forEach(id => { els[id] = { style: {}, textContent: '', className: '' }; });
    const blocked = [];
    const sb = {
      window: { PhaseUI: { setMarkingBlocked: r => blocked.push(r) } },
      document: { readyState: 'complete', addEventListener() {}, getElementById: id => els[id] || null },
      state: { connMode: 'supabase' }, setInterval() {}, console, Date
    };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'presence.js'), 'utf8'), sb);
    sb.window.PresenceUI.onCloudData(dev);
    return { age: els.presenceAge.textContent, title: els.presenceBadge.title, label: els.presenceLabel.textContent, cls: els.presenceBadge.className, banner: els.presenceStaleBanner.style.display, blocked: blocked[blocked.length - 1] };
  }
  const nowIso = new Date().toISOString();
  const old = new Date(Date.now() - 1800 * 1000).toISOString();
  const a = run({ updated_at: nowIso, last_seen_at: old });
  assert.strictEqual(a.label, 'ออฟไลน์');
  assert.ok(a.cls.includes('presence-offline'));
  assert.strictEqual(a.banner, 'block');
  assert.ok(a.blocked.length > 0);
  const b = run({ updated_at: nowIso });             // ไม่มีคอลัมน์ last_seen_at
  assert.strictEqual(b.label, 'ยังไม่เคยเห็นบอร์ด');
  assert.ok(b.cls.includes('presence-never'));
  assert.strictEqual(b.age, '');                      // ไม่แสดงศัพท์เทคนิคบนหัวหน้า
  assert.ok(b.title.includes('last_seen_at'));        // คำอธิบายอยู่ใน tooltip
  assert.strictEqual(b.banner, 'none');
  assert.strictEqual(b.blocked, '');                 // ไม่ปิดปุ่มมาร์ก
  const c = run({ updated_at: old, last_seen_at: null });
  assert.strictEqual(c.label, 'ยังไม่เคยเห็นบอร์ด');
  assert.strictEqual(c.blocked, '');
  const d = run({ updated_at: old, last_seen_at: nowIso });
  assert.strictEqual(d.label, 'ออนไลน์');
  assert.strictEqual(d.blocked, '');
});
t('วันที่เสีย -> ไม่ทราบ (ไม่ฟันธงว่าออฟไลน์)', () => {
  assert.strictEqual(st('not-a-date'), 'unknown');
  assert.strictEqual(st('2026-13-45'), 'unknown');
  assert.strictEqual(T.presenceOf(ago(5), NaN).status, 'unknown');
});
t('เวลาในอนาคตไม่เกิน 60 วิ -> ออนไลน์', () => {
  assert.strictEqual(st(ago(-1)), 'online');
  assert.strictEqual(st(ago(-60)), 'online');
  assert.strictEqual(T.presenceOf(ago(-30), NOW).ageSec, 0);
});
t('เวลาในอนาคตเกิน 60 วิ -> ไม่ทราบ', () => {
  assert.strictEqual(st(ago(-61)), 'unknown');
  assert.strictEqual(st(ago(-3600)), 'unknown');
});
t('รับรูปแบบเวลาแบบ Supabase (+00:00) ได้', () => {
  assert.strictEqual(st('2026-11-02T11:58:00.123+00:00'), 'online');
  assert.strictEqual(st('2026-11-02T18:58:00+07:00'), 'online');
});
t('lastSeenText: วินาที', () => {
  assert.strictEqual(T.lastSeenText(0), 'เห็นล่าสุดเมื่อ 0 วินาทีที่แล้ว');
  assert.strictEqual(T.lastSeenText(5), 'เห็นล่าสุดเมื่อ 5 วินาทีที่แล้ว');
  assert.strictEqual(T.lastSeenText(59), 'เห็นล่าสุดเมื่อ 59 วินาทีที่แล้ว');
});
t('lastSeenText: นาที', () => {
  assert.strictEqual(T.lastSeenText(60), 'เห็นล่าสุดเมื่อ 1 นาทีที่แล้ว');
  assert.strictEqual(T.lastSeenText(125), 'เห็นล่าสุดเมื่อ 2 นาทีที่แล้ว');
  assert.strictEqual(T.lastSeenText(3599), 'เห็นล่าสุดเมื่อ 59 นาทีที่แล้ว');
});
t('lastSeenText: ชั่วโมง', () => {
  assert.strictEqual(T.lastSeenText(3600), 'เห็นล่าสุดเมื่อ 1 ชั่วโมงที่แล้ว');
  assert.strictEqual(T.lastSeenText(7300), 'เห็นล่าสุดเมื่อ 2 ชั่วโมงที่แล้ว');
  assert.strictEqual(T.lastSeenText(90000), 'เห็นล่าสุดเมื่อ 25 ชั่วโมงที่แล้ว');
});
t('lastSeenText: ไม่มีข้อมูล', () => {
  assert.strictEqual(T.lastSeenText(null), 'ยังไม่เคยเห็นข้อมูลจากบอร์ด');
  assert.strictEqual(T.lastSeenText(undefined), 'ยังไม่เคยเห็นข้อมูลจากบอร์ด');
  assert.strictEqual(T.lastSeenText(-3), 'ยังไม่เคยเห็นข้อมูลจากบอร์ด');
});
t('markBlockReason: ปิดเฉพาะออฟไลน์', () => {
  assert.ok(T.markBlockReason('offline').length > 0);
  ['online', 'slow', 'unknown', 'never'].forEach(s => assert.strictEqual(T.markBlockReason(s), ''));
});

console.log('\n' + n + ' tests passed');
