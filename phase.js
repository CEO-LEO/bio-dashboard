/**
 * รอบเพาะเลี้ยง + เฟสจุลินทรีย์สังเคราะห์แสง (PSB) ประมาณจากระดับสี
 *
 * ข้อมูลที่ใช้
 *   esp32_devices (id = 1): color_r/g/b/c, temperature (จากเซนเซอร์), batch_started_at, batch_name
 *   batch_color_log: ประวัติสีของแต่ละรอบ + ป้ายที่ผู้ใช้มาร์กเอง (label)
 *
 * ผลลัพธ์ทั้งหมดเป็น "ประมาณการ" จากสี ไม่ใช่ค่าที่วัดตรงของจุลินทรีย์
 *
 * วิธีประมาณเฟส (ดู determinePhase)
 *   โหมดปรับเทียบ: มีป้ายใน batch_color_log พอ -> หา label ที่ median ของ redness ใกล้สีปัจจุบันที่สุด
 *     ชมพูอ่อน = เฟส 1, แดง = เฟส 2, แดงเข้ม/พร้อมใช้ = เฟส 3, ซีด/ผิดปกติ = เฟส 5
 *     ถ้าใกล้เฟส 3 และสีนิ่ง (6 ค่าล่าสุดต่างกันน้อยกว่า 2% ของ redness) -> เฟส 4
 *   โหมดสำรองตามเวลา: ใช้ช่วงวันที่ตั้งไว้ (ปรับได้) และเฟส 5 ตัดสินจากสีเท่านั้น
 */
(function () {
  'use strict';

  var LS_CFG = 'psb_phase_cfg';
  var LS_BATCH = 'psb_phase_batch';
  var LOG_INTERVAL_MS = 10 * 60 * 1000;
  var DAY_MS = 86400000;
  var STABLE_RANGE = 0.02;      // สีนิ่ง: redness ต่างกันน้อยกว่า 2% (ค่า redness อยู่ในช่วง 0-1)
  var FADE_RATIO = 0.15;        // ซีดลงจากค่าสูงสุดมากกว่า 15%
  var TREND_ROWS = 6;
  var MIN_FADE_SAMPLES = 3;
  var MIN_CALIB_LABELS = 2;
  var MIN_CALIB_ROWS = 3;
  var DEFAULT_CFG = { p1End: 2, p2End: 5, p3End: 15 };

  var PHASES = {
    1: 'เริ่มต้น/ปรับตัว',
    2: 'เติบโต',
    3: 'พร้อมใช้',
    4: 'คงที่',
    5: 'เสื่อม/ตรวจสอบ'
  };

  // ป้ายที่ผู้ใช้มาร์ก -> เฟส
  var LABELS = [
    { key: 'ชมพูอ่อน', phase: 1 },
    { key: 'แดง', phase: 2 },
    { key: 'แดงเข้ม/พร้อมใช้', phase: 3 },
    { key: 'ซีด/ผิดปกติ', phase: 5 }
  ];

  // ต้องตรงกับ phase.sql (ตัดคอมเมนต์และ RLS ที่เป็นส่วนเสริมไว้ในไฟล์นั้น)
  var SQL = [
    'alter table public.esp32_devices add column if not exists batch_started_at timestamptz;',
    "alter table public.esp32_devices add column if not exists batch_name text not null default '';",
    'create table if not exists public.batch_color_log (',
    '  id bigserial primary key,',
    '  batch_started_at timestamptz not null,',
    '  logged_at timestamptz not null default now(),',
    '  color_r int, color_g int, color_b int, color_c int,',
    '  temperature double precision,',
    "  label text not null default ''",
    ');',
    'alter table public.batch_color_log enable row level security;',
    'grant select, insert on public.batch_color_log to anon;',
    'grant usage on sequence public.batch_color_log_id_seq to anon;',
    'create policy anon_select_batch_color_log on public.batch_color_log for select to anon using (true);',
    'create policy anon_insert_batch_color_log on public.batch_color_log for insert to anon with check (true);'
  ].join('\n');
  var SQL_NOTE = '\n-- (ฉบับเต็มอยู่ในไฟล์ phase.sql)';

  // ---------- ฟังก์ชันคำนวณ (pure) ----------

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // สัดส่วนสีแดง 0-1 ; ไม่มีข้อมูล/ผลรวมเป็นศูนย์ -> null
  function redness(r, g, b) {
    r = toNum(r); g = toNum(g); b = toNum(b);
    if (r === null || g === null || b === null) return null;
    var sum = r + g + b;
    if (!(sum > 0)) return null;
    return r / sum;
  }

  // Hue 0-360 องศา ; ไม่มีข้อมูล/ผลรวมเป็นศูนย์ -> null ; สีเทา -> 0
  function hue(r, g, b) {
    r = toNum(r); g = toNum(g); b = toNum(b);
    if (r === null || g === null || b === null) return null;
    if (!(r + g + b > 0)) return null;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    var h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  function median(list) {
    var a = (list || []).map(toNum).filter(function (v) { return v !== null; }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // สีตัวอย่างสำหรับแสดงผล: หารด้วย clear channel แล้วขยายให้ช่องที่สว่างสุดเต็ม 255
  function swatchColor(r, g, b, c) {
    r = toNum(r); g = toNum(g); b = toNum(b); c = toNum(c);
    if (r === null || g === null || b === null) return null;
    var base = c !== null && c > 0 ? c : Math.max(r, g, b);
    if (!(base > 0)) return null;
    var n = [r / base, g / base, b / base];
    var peak = Math.max(n[0], n[1], n[2]);
    if (!(peak > 0)) return null;
    return n.map(function (v) { return Math.max(0, Math.min(255, Math.round(v / peak * 255))); });
  }

  // เฟสตามเวลา (โหมดสำรอง) ; days < 0 ถือเป็นเฟส 1
  function phaseByTime(days, cfg) {
    cfg = cfg || DEFAULT_CFG;
    var d = Math.floor(toNum(days) === null ? 0 : days);
    if (d <= cfg.p1End) return 1;
    if (d <= cfg.p2End) return 2;
    if (d <= cfg.p3End) return 3;
    return 4;
  }

  function validCfg(c) {
    return !!c && [c.p1End, c.p2End, c.p3End].every(function (v) { return typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= 365; }) &&
      c.p1End < c.p2End && c.p2End < c.p3End;
  }

  // แนวโน้มจากค่า redness ล่าสุด (history เรียงเก่า -> ใหม่) ; ข้อมูลไม่พอ -> stable = null
  function trendOf(history) {
    var vals = (history || []).map(function (h) { return redness(h.r, h.g, h.b); })
      .filter(function (v) { return v !== null; }).slice(-TREND_ROWS);
    if (vals.length < 3) return { stable: null, range: null, delta: null, n: vals.length };
    var range = Math.max.apply(null, vals) - Math.min.apply(null, vals);
    return { stable: range < STABLE_RANGE, range: range, delta: vals[vals.length - 1] - vals[0], n: vals.length };
  }

  // สีซีดลงจากช่วงสูงสุดมากกว่า 15% (เทียบแบบสัมพัทธ์ของ redness) ; ตัวอย่างน้อยไป -> false
  function isFaded(history, current) {
    var vals = (history || []).map(function (h) { return redness(h.r, h.g, h.b); })
      .filter(function (v) { return v !== null; });
    if (current !== null && current !== undefined) vals.push(current);
    if (vals.length < MIN_FADE_SAMPLES) return false;
    var peak = Math.max.apply(null, vals);
    var cur = current !== null && current !== undefined ? current : vals[vals.length - 1];
    return peak > 0 && cur < peak * (1 - FADE_RATIO);
  }

  function labelPhase(label) {
    for (var i = 0; i < LABELS.length; i++) if (LABELS[i].key === label) return LABELS[i].phase;
    return null;
  }

  // median ของ redness ต่อ label  -> { label: { median, n, phase } } (เฉพาะ label ที่รู้จักและมีค่าอ่านได้)
  function labelMedians(rows) {
    var groups = {};
    (rows || []).forEach(function (row) {
      if (!row || !row.label || labelPhase(row.label) === null) return;
      var v = redness(row.r, row.g, row.b);
      if (v === null) return;
      (groups[row.label] = groups[row.label] || []).push(v);
    });
    var out = {};
    Object.keys(groups).forEach(function (k) {
      out[k] = { median: median(groups[k]), n: groups[k].length, phase: labelPhase(k) };
    });
    return out;
  }

  function calibrationReady(meds) {
    var keys = Object.keys(meds || {});
    var rows = keys.reduce(function (s, k) { return s + meds[k].n; }, 0);
    return keys.length >= MIN_CALIB_LABELS && rows >= MIN_CALIB_ROWS;
  }

  function nearestLabel(value, meds) {
    var best = null;
    Object.keys(meds || {}).forEach(function (k) {
      var dist = Math.abs(value - meds[k].median);
      if (best === null || dist < best.dist) best = { label: k, phase: meds[k].phase, dist: dist };
    });
    return best;
  }

  /**
   * input: { days, redness, history:[{r,g,b}] เก่า->ใหม่ (รอบปัจจุบัน), labelRows:[{label,r,g,b}], cfg }
   * คืน { phase, mode: 'none'|'time'|'calibrated', nearest, trend }
   */
  function determinePhase(input) {
    input = input || {};
    var days = toNum(input.days);
    if (days === null) return { phase: null, mode: 'none', nearest: null, trend: null };
    var cur = toNum(input.redness);
    var history = input.history || [];
    var trend = trendOf(history);
    var meds = labelMedians(input.labelRows);

    if (cur !== null && calibrationReady(meds)) {
      var near = nearestLabel(cur, meds);
      var ph = near.phase;
      if (ph === 3 && trend.stable === true) ph = 4;
      return { phase: ph, mode: 'calibrated', nearest: near.label, trend: trend };
    }

    var cfg = validCfg(input.cfg) ? input.cfg : DEFAULT_CFG;
    var phase = phaseByTime(days, cfg);
    if (phase >= 3 && isFaded(history, cur)) phase = 5;
    return { phase: phase, mode: 'time', nearest: null, trend: trend };
  }

  function fmtElapsed(ms) {
    if (!(ms >= 0)) return '-';
    var totalH = Math.floor(ms / 3600000);
    return Math.floor(totalH / 24) + ' วัน ' + (totalH % 24) + ' ชั่วโมง';
  }

  // ---------- สถานะหน้าเว็บ ----------

  var batch = null;              // { startedAt: ISO, name }
  var cfg = { p1End: DEFAULT_CFG.p1End, p2End: DEFAULT_CFG.p2End, p3End: DEFAULT_CFG.p3End };
  var color = null;              // { r,g,b,c,temp }
  var logRows = [];              // แถวของรอบปัจจุบัน เก่า -> ใหม่ { r,g,b,c,t(ms),label }
  var labelRows = [];            // แถวที่มีป้าย จากทุกรอบ
  var lastLogged = null;         // { r,g,b,c,t }
  var cloudHasBatchCols = null;
  var cloudHasLogTable = null;
  var logTableChecked = false;
  var els = {};

  function toast(msg, type, ms) {
    if (typeof showToast === 'function') showToast(msg, type || 'info', ms || 2500);
  }

  function isCloudMode() {
    return typeof state !== 'undefined' && state.connMode === 'supabase';
  }

  function client() {
    return typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
  }

  function startedMs() {
    if (!batch) return null;
    var t = new Date(batch.startedAt).getTime();
    return isFinite(t) ? t : null;
  }

  function sameBatch(a, b) {
    var x = new Date(a).getTime(), y = new Date(b).getTime();
    return isFinite(x) && isFinite(y) && x === y;
  }

  function isMissingTable(err) {
    var msg = String((err && err.message) || '');
    var code = String((err && err.code) || '');
    return code === 'PGRST205' || code === '42P01' ||
      (msg.indexOf('batch_color_log') !== -1 && /not find|does not exist|schema cache/i.test(msg));
  }

  function isMissingBatchCol(err) {
    var msg = String((err && err.message) || '');
    return msg.indexOf('batch_started_at') !== -1 || msg.indexOf('batch_name') !== -1;
  }

  // ---------- localStorage ----------

  function loadLocal() {
    try {
      var c = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
      if (validCfg(c)) cfg = { p1End: c.p1End, p2End: c.p2End, p3End: c.p3End };
    } catch (e) { /* ignore */ }
    try {
      var b = JSON.parse(localStorage.getItem(LS_BATCH) || 'null');
      if (b && b.startedAt && isFinite(new Date(b.startedAt).getTime())) batch = { startedAt: b.startedAt, name: String(b.name || '') };
    } catch (e) { /* ignore */ }
  }

  function persistBatch() {
    try {
      if (batch) localStorage.setItem(LS_BATCH, JSON.stringify(batch));
      else localStorage.removeItem(LS_BATCH);
    } catch (e) { /* ignore */ }
  }

  function persistCfg() {
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  // ---------- Cloud ----------

  function rowFromDb(row) {
    return {
      r: row.color_r, g: row.color_g, b: row.color_b, c: row.color_c,
      t: new Date(row.logged_at).getTime(), label: row.label || '',
      batch: row.batch_started_at
    };
  }

  function loadLog() {
    var cl = client();
    if (!cl || !isCloudMode()) return;
    cl.from('batch_color_log').select('*').order('logged_at', { ascending: false }).limit(300)
      .then(function (res) {
        if (res && res.error) {
          if (isMissingTable(res.error)) cloudHasLogTable = false;
          renderNotice();
          return;
        }
        cloudHasLogTable = true;
        var all = (res.data || []).map(rowFromDb).reverse(); // เก่า -> ใหม่
        labelRows = all.filter(function (x) { return x.label; });
        logRows = batch ? all.filter(function (x) { return sameBatch(x.batch, batch.startedAt); }) : [];
        var last = logRows.length ? logRows[logRows.length - 1] : null;
        lastLogged = last ? { r: last.r, g: last.g, b: last.b, c: last.c, t: last.t } : null;
        renderNotice();
        render();
      })
      .catch(function () { /* เครือข่ายล้มเหลว: ใช้ข้อมูลเดิม */ });
  }

  function insertLog(label) {
    var cl = client();
    if (!batch || !color) return false;
    var row = {
      batch_started_at: batch.startedAt,
      color_r: color.r, color_g: color.g, color_b: color.b, color_c: color.c,
      temperature: color.temp,
      label: label || ''
    };
    if (!cl || !isCloudMode()) { toast('ต้องเชื่อมต่อ Cloud จึงจะบันทึกประวัติสีได้', 'error', 3000); return false; }
    var entry = { r: color.r, g: color.g, b: color.b, c: color.c, t: Date.now(), label: label || '', batch: batch.startedAt };
    cl.from('batch_color_log').insert(row).then(function (res) {
      if (res && res.error) {
        if (isMissingTable(res.error)) { cloudHasLogTable = false; renderNotice(); toast('ยังไม่มีตาราง batch_color_log (ดูกรอบสีส้ม)', 'error', 4000); }
        else toast('บันทึกประวัติสีไม่สำเร็จ: ' + res.error.message, 'error', 4000);
        return;
      }
      cloudHasLogTable = true;
      logRows.push(entry);
      if (entry.label) labelRows.push(entry);
      lastLogged = { r: entry.r, g: entry.g, b: entry.b, c: entry.c, t: entry.t };
      if (entry.label) toast('มาร์กสี "' + entry.label + '" แล้ว', 'success', 2000);
      renderNotice();
      render();
    }).catch(function () { toast('บันทึกประวัติสีไม่สำเร็จ (เครือข่าย)', 'error'); });
    return true;
  }

  function sameColorAsLast(c) {
    return !!lastLogged && lastLogged.r === c.r && lastLogged.g === c.g && lastLogged.b === c.b && lastLogged.c === c.c;
  }

  // บันทึกอัตโนมัติ: ทุก 10 นาที เมื่อมีรอบ มีค่าสี และไม่ซ้ำค่าล่าสุดที่บันทึก
  function maybeAutoLog() {
    if (!batch || !color || cloudHasLogTable === false || !isCloudMode()) return;
    if (color.r === null || color.g === null || color.b === null) return;
    if (lastLogged && Date.now() - lastLogged.t < LOG_INTERVAL_MS) return;
    if (sameColorAsLast(color)) return;
    insertLog('');
  }

  function writeBatch(newBatch, okMsg) {
    var prev = batch;
    batch = newBatch;
    persistBatch();
    logRows = [];
    lastLogged = null;
    render();
    if (!isCloudMode() || !client()) {
      toast('บันทึกในเบราว์เซอร์แล้ว (เชื่อมต่อ Cloud เพื่อซิงก์และบันทึกประวัติสี)', 'info', 3500);
      return;
    }
    client().from('esp32_devices')
      .update({
        batch_started_at: newBatch ? newBatch.startedAt : null,
        batch_name: newBatch ? newBatch.name : '',
        updated_at: new Date().toISOString()
      })
      .eq('id', 1)
      .then(function (res) {
        if (res && res.error) {
          if (isMissingBatchCol(res.error)) {
            cloudHasBatchCols = false;
            renderNotice();
            toast('ยังไม่มีคอลัมน์ในฐานข้อมูล (ดูกรอบสีส้ม) — บันทึกไว้ในเบราว์เซอร์ก่อน', 'error', 5000);
          } else {
            batch = prev;
            persistBatch();
            render();
            toast('บันทึกรอบไป Cloud ไม่สำเร็จ: ' + res.error.message, 'error', 4000);
          }
          return;
        }
        cloudHasBatchCols = true;
        renderNotice();
        toast(okMsg, 'success', 2500);
        loadLog();
      })
      .catch(function () { toast('บันทึกรอบไป Cloud ไม่สำเร็จ (เครือข่าย)', 'error'); });
  }

  function startBatch() {
    if (batch && !window.confirm('มีรอบ "' + (batch.name || 'ไม่มีชื่อ') + '" อยู่แล้ว (เริ่ม ' + new Date(batch.startedAt).toLocaleString('th-TH') + ')\nต้องการเริ่มรอบใหม่แทนที่หรือไม่?')) return;
    var name = (els.nameInput.value || '').trim();
    if (!name) name = 'รอบ ' + new Date().toLocaleDateString('th-TH');
    writeBatch({ startedAt: new Date().toISOString(), name: name }, 'เริ่มรอบเพาะเลี้ยงแล้ว');
    els.nameInput.value = '';
  }

  function endBatch() {
    if (!batch) return;
    if (!window.confirm('จบรอบ "' + (batch.name || 'ไม่มีชื่อ') + '" ใช่หรือไม่? (ประวัติสีที่บันทึกไว้ยังอยู่)')) return;
    writeBatch(null, 'จบรอบเพาะเลี้ยงแล้ว');
  }

  // เรียกจาก app.js ทุกครั้งที่ได้ข้อมูลอุปกรณ์จาก Supabase
  function onCloudData(dev) {
    if (!dev) return;
    var has = Object.prototype.hasOwnProperty;

    var r = toNum(dev.color_r), g = toNum(dev.color_g), b = toNum(dev.color_b);
    if (r !== null && g !== null && b !== null) {
      color = { r: r, g: g, b: b, c: toNum(dev.color_c), temp: toNum(dev.temperature) };
    }

    if (has.call(dev, 'batch_started_at')) {
      cloudHasBatchCols = true;
      var incoming = dev.batch_started_at ? { startedAt: dev.batch_started_at, name: String(dev.batch_name || '') } : null;
      var changed = (incoming === null) !== (batch === null) ||
        (incoming && batch && !sameBatch(incoming.startedAt, batch.startedAt));
      if (changed || (incoming && batch && incoming.name !== batch.name)) {
        batch = incoming;
        persistBatch();
        if (changed) { logRows = []; lastLogged = null; loadLog(); }
      }
    } else {
      cloudHasBatchCols = false;
    }

    if (!logTableChecked) { logTableChecked = true; loadLog(); }
    renderNotice();
    render();
  }

  // ---------- การแสดงผล ----------

  function renderNotice() {
    if (!els.notice) return;
    var show = isCloudMode() && (cloudHasBatchCols === false || cloudHasLogTable === false);
    els.notice.style.display = show ? 'block' : 'none';
  }

  function setText(el, text) { if (el) el.textContent = text; }

  function render() {
    if (!els.section) return;

    var hasBatch = !!batch;
    setText(els.batchName, hasBatch ? (batch.name || 'ไม่มีชื่อ') : 'ยังไม่ได้เริ่มรอบ');
    setText(els.batchStart, hasBatch ? new Date(batch.startedAt).toLocaleString('th-TH') : '-');
    var ms = startedMs();
    var elapsed = hasBatch && ms !== null ? Date.now() - ms : null;
    setText(els.elapsed, elapsed !== null ? fmtElapsed(elapsed) : '-');
    els.endBtn.disabled = !hasBatch;
    els.startBtn.textContent = hasBatch ? 'เริ่มรอบใหม่' : 'เริ่มรอบเพาะเลี้ยง';
    Array.prototype.forEach.call(els.markBtns, function (btn) { btn.disabled = !hasBatch || !color; });

    var red = color ? redness(color.r, color.g, color.b) : null;
    var hu = color ? hue(color.r, color.g, color.b) : null;
    setText(els.redness, red !== null ? (red * 100).toFixed(1) + '%' : '-');
    setText(els.hue, hu !== null ? Math.round(hu) + '°' : '-');
    setText(els.temp, color && color.temp !== null ? color.temp.toFixed(1) + ' °C' : '-');
    var sw = color ? swatchColor(color.r, color.g, color.b, color.c) : null;
    els.swatch.style.background = sw ? 'rgb(' + sw.join(',') + ')' : 'transparent';
    els.swatch.title = sw ? 'rgb(' + sw.join(', ') + ')' : 'ยังไม่มีค่าสี';

    var res = determinePhase({
      days: elapsed !== null ? elapsed / DAY_MS : null,
      redness: red, history: logRows, labelRows: labelRows, cfg: cfg
    });

    setText(els.phaseName, res.phase ? 'เฟส ' + res.phase + ' — ' + PHASES[res.phase] : 'ยังไม่เริ่มรอบ');
    els.phaseEstimate.style.display = res.phase ? 'inline-block' : 'none';
    var modeText = '';
    if (res.mode === 'calibrated') {
      modeText = 'โหมดปรับเทียบ: สีใกล้ป้าย "' + res.nearest + '"' +
        (res.trend && res.trend.stable === true ? ' และสีนิ่ง' : '');
    } else if (res.mode === 'time') {
      modeText = 'โหมดสำรองตามเวลา (ยังมีป้ายปรับเทียบไม่พอ)' +
        (res.phase === 5 ? ' — สีซีดลงจากช่วงสูงสุดเกิน 15%' : '');
    } else {
      modeText = 'กด "เริ่มรอบเพาะเลี้ยง" เพื่อเริ่มติดตามเฟส';
    }
    setText(els.phaseMode, modeText);

    Array.prototype.forEach.call(els.steps, function (step, i) {
      var cur = res.phase === i + 1;
      step.className = 'ph-step' + (cur ? ' is-current' : '') + (res.phase && i + 1 < res.phase ? ' is-past' : '');
    });
  }

  function validateCfgInputs() {
    var c = {
      p1End: parseInt(els.cfg1.value, 10),
      p2End: parseInt(els.cfg2.value, 10),
      p3End: parseInt(els.cfg3.value, 10)
    };
    if (!validCfg(c)) { toast('ช่วงวันต้องเป็นจำนวนเต็ม 0-365 และเรียงจากน้อยไปมาก', 'error', 3500); return; }
    cfg = c;
    persistCfg();
    render();
    toast('บันทึกช่วงวันของเฟสแล้ว', 'success', 2000);
  }

  function resetCfg() {
    cfg = { p1End: DEFAULT_CFG.p1End, p2End: DEFAULT_CFG.p2End, p3End: DEFAULT_CFG.p3End };
    persistCfg();
    fillCfgInputs();
    render();
  }

  function fillCfgInputs() {
    els.cfg1.value = cfg.p1End;
    els.cfg2.value = cfg.p2End;
    els.cfg3.value = cfg.p3End;
  }

  function init() {
    els = {
      section: document.getElementById('phaseSection'),
      notice: document.getElementById('phaseNotice'),
      sqlCopy: document.getElementById('phaseSqlCopy'),
      nameInput: document.getElementById('phBatchNameInput'),
      startBtn: document.getElementById('phStartBtn'),
      endBtn: document.getElementById('phEndBtn'),
      batchName: document.getElementById('phBatchName'),
      batchStart: document.getElementById('phBatchStart'),
      elapsed: document.getElementById('phElapsed'),
      phaseName: document.getElementById('phPhaseName'),
      phaseEstimate: document.getElementById('phEstimateBadge'),
      phaseMode: document.getElementById('phPhaseMode'),
      swatch: document.getElementById('phSwatch'),
      redness: document.getElementById('phRedness'),
      hue: document.getElementById('phHue'),
      temp: document.getElementById('phTemp'),
      steps: document.querySelectorAll('#phaseSection .ph-step'),
      markBtns: document.querySelectorAll('#phaseSection [data-ph-mark]'),
      cfg1: document.getElementById('phCfg1'),
      cfg2: document.getElementById('phCfg2'),
      cfg3: document.getElementById('phCfg3'),
      cfgSave: document.getElementById('phCfgSave'),
      cfgReset: document.getElementById('phCfgReset')
    };
    if (!els.section) return;

    loadLocal();
    fillCfgInputs();

    els.startBtn.addEventListener('click', startBatch);
    els.endBtn.addEventListener('click', endBatch);
    els.cfgSave.addEventListener('click', validateCfgInputs);
    els.cfgReset.addEventListener('click', resetCfg);
    Array.prototype.forEach.call(els.markBtns, function (btn) {
      btn.addEventListener('click', function () { insertLog(btn.getAttribute('data-ph-mark')); });
    });
    if (els.sqlCopy) {
      els.sqlCopy.addEventListener('click', function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(SQL + SQL_NOTE).then(function () {
            toast('คัดลอกคำสั่ง SQL แล้ว นำไปรันใน Supabase → SQL Editor', 'success', 3500);
          });
        }
      });
    }

    render();
    renderNotice();
    setInterval(function () { render(); maybeAutoLog(); }, 60000);
  }

  window.PhaseUI = {
    onCloudData: onCloudData,
    // เปิดไว้ให้ทดสอบ
    _test: {
      redness: redness, hue: hue, median: median, swatchColor: swatchColor,
      phaseByTime: phaseByTime, trendOf: trendOf, isFaded: isFaded,
      labelMedians: labelMedians, calibrationReady: calibrationReady, nearestLabel: nearestLabel,
      determinePhase: determinePhase, validCfg: validCfg, fmtElapsed: fmtElapsed,
      DEFAULT_CFG: DEFAULT_CFG, SQL: SQL
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
