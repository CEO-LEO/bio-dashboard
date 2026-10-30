/**
 * ระบบตั้งเวลาเปิด-ปิดรีเลย์อัตโนมัติ (Schedule)
 *
 * เก็บตารางเป็นข้อความในคอลัมน์ schedule_text ของตาราง esp32_devices (id = 1)
 * รูปแบบ: "ช่อง,ชนิด,ค่า1,ค่า2,เปิดใช้;ช่อง,ชนิด,ค่า1,ค่า2,เปิดใช้;..."
 *   ชนิด D = ช่วงเวลารายวัน : ค่า1 = นาทีเริ่ม (0-1439), ค่า2 = นาทีสิ้นสุด (0-1439)
 *   ชนิด I = วนรอบ          : ค่า1 = คาบ (นาที),         ค่า2 = เปิดนานกี่นาที
 *   ตัวอย่าง: "2,I,180,10,1;1,D,360,1080,1;"
 *     = ช่อง 2 เปิด 10 นาทีทุก 3 ชั่วโมง, ช่อง 1 เปิด 06:00-18:00 ทุกวัน
 *
 * บอร์ด ESP32 อ่านข้อความเดียวกันนี้และทำงานตามเวลาเอง (ต้องตรงกับ firmware)
 * เวลาที่ใช้คือเวลาไทย (UTC+7) ทั้งฝั่งเว็บและฝั่งบอร์ด
 */
(function () {
  'use strict';

  var TZ_OFFSET_MIN = 7 * 60; // ต้องตรงกับ TZ_OFFSET_SEC ใน firmware
  var CH_NAMES = ['ไฟ Grow Light', 'ปั๊ม Oxygen', 'อากาศออก', 'ปลั๊กเสริม (Aux)'];
  var LS_KEY = 'esp32_schedule';
  var MAX_RULES = 16;
  var SQL = "alter table public.esp32_devices add column if not exists schedule_text text not null default '';";

  var rules = [];
  var cloudHasColumn = null; // null = ยังไม่ทราบ
  var saveInFlightUntil = 0;
  var els = {};

  // ---------- ตรรกะหลัก (ต้องเหมือนใน firmware ทุกประการ) ----------

  function toInt(str) {
    return /^\s*-?\d+\s*$/.test(str) ? parseInt(str, 10) : NaN;
  }

  function parse(text) {
    var out = [];
    String(text || '').split(';').forEach(function (part) {
      part = part.trim();
      if (!part || out.length >= MAX_RULES) return;
      var f = part.split(',');
      if (f.length < 4) return;
      var ch = toInt(f[0]);
      var type = (f[1] || '').trim();
      var p1 = toInt(f[2]);
      var p2 = toInt(f[3]);
      var en = f.length >= 5 ? toInt(f[4]) : 1;
      if (isNaN(en)) en = 1; // เหมือน firmware: ค่าเปิดใช้อ่านไม่ได้ = เปิดใช้
      if (!(ch >= 1 && ch <= 4)) return;
      if (isNaN(p1) || isNaN(p2)) return;
      if (type === 'D') {
        if (p1 < 0 || p1 > 1439 || p2 < 0 || p2 > 1439) return;
      } else if (type === 'I') {
        if (p1 < 1 || p1 > 1440 || p2 < 1) return;
      } else {
        return;
      }
      out.push({ ch: ch, type: type, p1: p1, p2: p2, en: en ? 1 : 0 });
    });
    return out;
  }

  function encode(list) {
    return list.map(function (r) {
      return [r.ch, r.type, r.p1, r.p2, r.en ? 1 : 0].join(',') + ';';
    }).join('');
  }

  // นาทีนับจาก epoch ตามเวลาท้องถิ่น (ไทย)
  function localEpochMinutes(nowMs) {
    return Math.floor((nowMs === undefined ? Date.now() : nowMs) / 60000) + TZ_OFFSET_MIN;
  }

  function isActive(r, epochMin) {
    if (r.type === 'D') {
      var m = epochMin % 1440;
      if (r.p1 === r.p2) return false;
      if (r.p1 < r.p2) return m >= r.p1 && m < r.p2;
      return m >= r.p1 || m < r.p2; // ข้ามเที่ยงคืน
    }
    if (r.type === 'I') {
      if (r.p1 <= 0) return false;
      return (epochMin % r.p1) < r.p2;
    }
    return false;
  }

  // ---------- ตัวช่วยแสดงผล ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }

  function fmtPeriod(min) {
    if (min % 60 === 0) return (min / 60) + ' ชม.';
    if (min > 60) return Math.floor(min / 60) + ' ชม. ' + (min % 60) + ' นาที';
    return min + ' นาที';
  }

  function describe(r) {
    if (r.type === 'D') return 'ทุกวัน ' + fmtTime(r.p1) + ' – ' + fmtTime(r.p2) + (r.p1 > r.p2 ? ' (ข้ามเที่ยงคืน)' : '');
    return 'ทุก ' + fmtPeriod(r.p1) + ' เปิดนาน ' + fmtPeriod(r.p2);
  }

  function toast(msg, type, ms) {
    if (typeof showToast === 'function') showToast(msg, type || 'info', ms || 2500);
  }

  function isCloudMode() {
    return typeof state !== 'undefined' && state.connMode === 'supabase';
  }

  // ---------- บันทึก / ซิงก์ ----------

  function persistLocal() {
    try { localStorage.setItem(LS_KEY, encode(rules)); } catch (e) { /* ignore */ }
  }

  function save(okMessage) {
    persistLocal();
    render();
    if (!isCloudMode() || typeof getSupabaseClient !== 'function') {
      toast('บันทึกในเบราว์เซอร์แล้ว (เชื่อมต่อ Cloud เพื่อส่งให้บอร์ด)', 'info', 3000);
      return;
    }
    var client = getSupabaseClient();
    if (!client) { toast('ยังไม่ได้เชื่อมต่อ Supabase', 'error'); return; }
    saveInFlightUntil = Date.now() + 3000;
    client.from('esp32_devices')
      .update({ schedule_text: encode(rules), updated_at: new Date().toISOString() })
      .eq('id', 1)
      .then(function (res) {
        if (res && res.error) {
          var msg = String(res.error.message || '');
          if (msg.indexOf('schedule_text') !== -1) {
            cloudHasColumn = false;
            renderNotice();
            toast('ยังไม่มีคอลัมน์ schedule_text ใน Supabase (ดูคำแนะนำในกรอบสีส้ม)', 'error', 5000);
          } else {
            toast('ส่งตารางเวลาไป Cloud ไม่สำเร็จ: ' + msg, 'error', 4000);
          }
        } else {
          cloudHasColumn = true;
          renderNotice();
          toast(okMessage || 'ส่งตารางเวลาให้บอร์ดแล้ว (บอร์ดรับภายใน ~15 วินาที)', 'success', 3000);
        }
      })
      .catch(function () { toast('ส่งตารางเวลาไป Cloud ไม่สำเร็จ (เครือข่าย)', 'error'); });
  }

  // เรียกจาก app.js ทุกครั้งที่ได้ข้อมูลอุปกรณ์จาก Supabase (ครั้งแรกและ Realtime)
  function onCloudData(dev) {
    if (!dev) return;
    if (Object.prototype.hasOwnProperty.call(dev, 'schedule_text')) {
      cloudHasColumn = true;
      if (Date.now() >= saveInFlightUntil) {
        var incoming = String(dev.schedule_text || '');
        if (incoming !== encode(rules)) {
          rules = parse(incoming);
          persistLocal();
          render();
        }
      }
    } else {
      cloudHasColumn = false;
    }
    renderNotice();
  }

  // ---------- การแสดงผล ----------

  function renderNotice() {
    if (!els.notice) return;
    var show = cloudHasColumn === false && isCloudMode();
    els.notice.style.display = show ? 'block' : 'none';
  }

  function render() {
    if (!els.list) return;
    els.list.innerHTML = '';
    els.empty.style.display = rules.length ? 'none' : 'block';
    var em = localEpochMinutes();

    rules.forEach(function (r, idx) {
      var row = document.createElement('div');
      row.className = 'sch-rule' + (r.en ? '' : ' is-disabled');

      var badge = document.createElement('span');
      badge.className = 'sch-ch';
      badge.textContent = 'CH ' + r.ch;

      var body = document.createElement('div');
      body.className = 'sch-body';
      var title = document.createElement('strong');
      title.textContent = CH_NAMES[r.ch - 1];
      var sub = document.createElement('span');
      sub.textContent = describe(r);
      body.appendChild(title);
      body.appendChild(sub);

      var live = document.createElement('span');
      var active = r.en && isActive(r, em);
      live.className = 'sch-live' + (active ? ' is-on' : '');
      live.textContent = !r.en ? 'ปิดใช้งาน' : (active ? 'กำลังเปิด' : 'รอเวลา');

      var label = document.createElement('label');
      label.className = 'switch-toggle';
      label.title = r.en ? 'ปิดใช้งานกฎนี้' : 'เปิดใช้งานกฎนี้';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!r.en;
      input.addEventListener('change', function () {
        rules[idx].en = input.checked ? 1 : 0;
        save();
      });
      var slider = document.createElement('span');
      slider.className = 'switch-slider';
      var ind = document.createElement('span');
      ind.className = 'switch-indicator';
      slider.appendChild(ind);
      label.appendChild(input);
      label.appendChild(slider);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'sch-del';
      del.setAttribute('aria-label', 'ลบกฎนี้');
      del.textContent = '✕';
      del.addEventListener('click', function () {
        rules.splice(idx, 1);
        save('ลบกฎแล้ว และส่งตารางใหม่ให้บอร์ด');
      });

      row.appendChild(badge);
      row.appendChild(body);
      row.appendChild(live);
      row.appendChild(label);
      row.appendChild(del);
      els.list.appendChild(row);
    });

    // ช่องที่อยู่ภายใต้ตารางเวลา: บอกผู้ใช้ว่าการกดสวิตช์มือจะถูกทับเมื่อถึงเวลาถัดไป
    var controlled = {};
    rules.forEach(function (r) { if (r.en) controlled[r.ch] = true; });
    var chs = Object.keys(controlled);
    els.summary.textContent = chs.length
      ? 'ช่องที่ทำงานตามตารางเวลา: ' + chs.map(function (c) { return 'CH ' + c; }).join(', ') +
        ' (สวิตช์มือยังกดได้ แต่จะถูกตารางเวลาสั่งทับเมื่อถึงเวลาเปลี่ยนสถานะถัดไป)'
      : 'ยังไม่มีช่องไหนใช้ตารางเวลา — ทุกช่องควบคุมด้วยมือ';
  }

  function updateFormVisibility() {
    var isD = els.type.value === 'D';
    els.dailyFields.style.display = isD ? 'flex' : 'none';
    els.intervalFields.style.display = isD ? 'none' : 'flex';
  }

  function timeToMin(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function addRule() {
    if (rules.length >= MAX_RULES) { toast('เพิ่มได้สูงสุด ' + MAX_RULES + ' กฎ', 'error'); return; }
    var ch = parseInt(els.channel.value, 10);
    var r;
    if (els.type.value === 'D') {
      var s = timeToMin(els.start.value), e = timeToMin(els.end.value);
      if (s === null || e === null) { toast('กรุณาเลือกเวลาเริ่มและเวลาสิ้นสุด', 'error'); return; }
      if (s === e) { toast('เวลาเริ่มกับเวลาสิ้นสุดต้องไม่เท่ากัน', 'error'); return; }
      r = { ch: ch, type: 'D', p1: s, p2: e, en: 1 };
    } else {
      var every = parseInt(els.every.value, 10);
      var unit = els.unit.value === 'h' ? 60 : 1;
      var on = parseInt(els.onFor.value, 10);
      var period = every * unit;
      if (!(every >= 1) || !(period >= 2) || period > 1440) { toast('คาบต้องอยู่ระหว่าง 2 นาที ถึง 24 ชั่วโมง', 'error'); return; }
      if (!(on >= 1)) { toast('ระยะเวลาเปิดต้องอย่างน้อย 1 นาที', 'error'); return; }
      if (on > period) { toast('ระยะเวลาเปิดต้องไม่เกินคาบ', 'error'); return; }
      r = { ch: ch, type: 'I', p1: period, p2: on, en: 1 };
    }
    rules.push(r);
    save('เพิ่มกฎแล้ว และส่งตารางให้บอร์ดแล้ว');
  }

  function init() {
    els = {
      section: document.getElementById('scheduleSection'),
      list: document.getElementById('scheduleList'),
      empty: document.getElementById('scheduleEmpty'),
      summary: document.getElementById('scheduleSummary'),
      notice: document.getElementById('scheduleNotice'),
      sqlCopy: document.getElementById('scheduleSqlCopy'),
      channel: document.getElementById('schChannel'),
      type: document.getElementById('schType'),
      dailyFields: document.getElementById('schDailyFields'),
      intervalFields: document.getElementById('schIntervalFields'),
      start: document.getElementById('schStart'),
      end: document.getElementById('schEnd'),
      every: document.getElementById('schEvery'),
      unit: document.getElementById('schUnit'),
      onFor: document.getElementById('schOnFor'),
      addBtn: document.getElementById('schAddBtn')
    };
    if (!els.section) return;

    try { rules = parse(localStorage.getItem(LS_KEY) || ''); } catch (e) { rules = []; }

    els.type.addEventListener('change', updateFormVisibility);
    els.addBtn.addEventListener('click', addRule);
    if (els.sqlCopy) {
      els.sqlCopy.addEventListener('click', function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(SQL).then(function () { toast('คัดลอกคำสั่ง SQL แล้ว นำไปรันใน Supabase → SQL Editor', 'success', 3500); });
        }
      });
    }
    updateFormVisibility();
    render();
    renderNotice();
    setInterval(render, 15000); // รีเฟรชป้าย "กำลังเปิด/รอเวลา"
  }

  window.ScheduleUI = {
    onCloudData: onCloudData,
    // เปิดไว้ให้ทดสอบ
    _test: { parse: parse, encode: encode, isActive: isActive, localEpochMinutes: localEpochMinutes, describe: describe, SQL: SQL }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
