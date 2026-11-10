/**
 * สูตรเพาะเลี้ยง (Culture Profile): เลือกว่าจะผลิตอะไร แล้วระบบตั้งตารางไฟ/ลมให้ตามระยะ
 *
 * - สูตรหนึ่งมีหลายระยะ (stage) แต่ละระยะมีตารางเวลา (รูปแบบ schedule_text เดิม) และช่วงอุณหภูมิที่แนะนำ
 * - ตารางเวลาถูกเขียนผ่าน ScheduleUI.replaceRules จึงใช้เส้นทางบันทึกเดิม และบอร์ดทำงานต่อเองได้แม้ปิดเว็บ
 * - การสลับระยะ "ไม่ได้ทำเองบนบอร์ด": เว็บแสดงแถบแจ้งเมื่อถึงระยะถัดไป ให้ผู้ใช้กดสลับ
 *   (การสลับอัตโนมัติแบบไม่ต้องเปิดเว็บต้องใช้ฝั่งเซิร์ฟเวอร์ ซึ่งยังไม่ได้ทำ)
 * - อุณหภูมิเป็นการเตือนเท่านั้น ไม่ได้ควบคุม และเป็นอุณหภูมิอากาศจาก DHT ไม่ใช่อุณหภูมิน้ำ
 * - สูตรที่เลือกเก็บใน localStorage ของเบราว์เซอร์นี้เท่านั้น ส่วนวันที่เริ่มรอบมาจาก batch_started_at (Cloud)
 *
 * ตัวเลขทุกตัวในตาราง PROFILES เป็น "ค่าเริ่มต้นทั่วไป ยังไม่ได้ตรวจกับแหล่งอ้างอิง" ต้องตรวจกับ
 * ตำราหรือผู้เชี่ยวชาญก่อนใช้จริง และแก้ได้ (ตารางเวลาแก้ในการ์ดตั้งเวลา, วันเริ่มระยะแก้ในการ์ดสูตร)
 */
(function () {
  'use strict';

  var LS_ACTIVE = 'bio_profile';
  var LS_PREV = 'bio_profile_prev_schedule';
  var LS_DAYS = 'bio_profile_stage_days';
  var DAY_MS = 86400000;
  var ALWAYS = { type: 'I', p1: 1440, p2: 1440 }; // เปิดตลอด (บอร์ดและเว็บตีความตรงกัน)

  function daily(ch, startMin, endMin) { return { ch: ch, type: 'D', p1: startMin, p2: endMin, en: 1 }; }
  function interval(ch, periodMin, onMin) { return { ch: ch, type: 'I', p1: periodMin, p2: onMin, en: 1 }; }
  function always(ch) { return { ch: ch, type: ALWAYS.type, p1: ALWAYS.p1, p2: ALWAYS.p2, en: 1 }; }
  var H = 60;

  // ช่อง: 1 = ไฟ Grow Light, 2 = ปั๊ม Oxygen, 3 = อากาศออก, 4 = ปลั๊กเสริม (Aux)
  var PROFILES = {
    psb: {
      name: 'จุลินทรีย์สังเคราะห์แสง (PSB)',
      sci: 'Purple non-sulfur bacteria',
      desc: 'ชอบแสงและสภาพออกซิเจนต่ำ จึงเปิดไฟอย่างเดียว ไม่เปิดปั๊มลม สีเปลี่ยนจากชมพูเป็นแดงเมื่อโต',
      hasPhaseCard: true,
      stages: [
        { name: 'เติบโตและเก็บเกี่ยว', fromDay: 0, temp: [30, 35], rules: [daily(1, 6 * H, 22 * H)] }
      ]
    },
    chlorella: {
      name: 'สาหร่ายเซลล์เดียว (Chlorella)',
      sci: 'Chlorella spp.',
      desc: 'ใช้แสงเป็นช่วงวัน และเติมอากาศตลอดเพื่อกวนและให้ CO₂ สีเขียวเข้มขึ้นเมื่อหนาแน่น',
      hasPhaseCard: false,
      stages: [
        { name: 'เติบโต', fromDay: 0, temp: [25, 30], rules: [daily(1, 6 * H, 20 * H), always(2)] }
      ]
    },
    moina: {
      name: 'ไรแดง (Moina)',
      sci: 'Moina spp. (สัตว์เปลือกแข็งหลายเซลล์ ไม่ใช่เซลล์เดียว)',
      desc: 'ต้องการออกซิเจนสม่ำเสมอ แสงไม่ใช่ปัจจัยหลัก กินสาหร่ายหรือ PSB เป็นอาหาร',
      hasPhaseCard: false,
      stages: [
        { name: 'เลี้ยง', fromDay: 0, temp: [24, 30], rules: [daily(1, 6 * H, 18 * H), always(2)] }
      ]
    },
    haematococcus: {
      name: 'Haematococcus pluvialis',
      sci: 'Haematococcus pluvialis',
      desc: 'ปลูก 2 ระยะ: เติบโตเป็นเซลล์เขียว แล้วกระตุ้นด้วยแสงแรงให้เปลี่ยนเป็นสีแดง (สะสมแอสตาแซนธิน) เซลล์บอบบางต่อการกวนแรง',
      hasPhaseCard: false,
      stages: [
        { name: 'ระยะเติบโต (เซลล์เขียว)', fromDay: 0, temp: [20, 28], rules: [daily(1, 6 * H, 22 * H), interval(2, 60, 30)] },
        { name: 'ระยะกระตุ้น (เปลี่ยนเป็นสีแดง)', fromDay: 10, temp: [20, 30], rules: [always(1), interval(2, 60, 30)],
          extraLampRules: [always(4)], extraLampNote: 'เพิ่มหลอดเสริมที่ CH 4 (เปิดตลอด)' },
        { name: 'ระยะเก็บเกี่ยว (สีแดงเข้ม)', fromDay: 24, temp: [20, 30], rules: [always(1), interval(2, 60, 30)],
          extraLampRules: [always(4)], extraLampNote: 'เพิ่มหลอดเสริมที่ CH 4 (เปิดตลอด)' }
      ]
    }
  };
  var ORDER = ['psb', 'chlorella', 'moina', 'haematococcus'];

  // ---------- ฟังก์ชันคำนวณ (pure) ----------

  function startDays(profile, daysOverride) {
    return profile.stages.map(function (s, i) {
      return daysOverride && typeof daysOverride[i] === 'number' ? daysOverride[i] : s.fromDay;
    });
  }

  // ดัชนีระยะที่ตรงกับ "วันที่ผ่านไป" ; days ไม่ใช่ตัวเลข/ติดลบ -> ระยะแรก
  function stageAt(profile, days, daysOverride) {
    var d = typeof days === 'number' && isFinite(days) ? days : 0;
    var starts = startDays(profile, daysOverride);
    var idx = 0;
    for (var i = 0; i < starts.length; i++) if (d >= starts[i]) idx = i;
    return idx;
  }

  // 'low' | 'ok' | 'high' | null (ไม่มีค่า)
  function tempStatus(band, t) {
    if (typeof t !== 'number' || !isFinite(t) || !band) return null;
    if (t < band[0]) return 'low';
    if (t > band[1]) return 'high';
    return 'ok';
  }

  // กฎของระยะ (สำเนา) ; extraLamp = ผู้ใช้ยืนยันว่ามีหลอดเสริมที่ CH 4
  function rulesFor(profile, stageIdx, opts) {
    var st = profile.stages[stageIdx];
    if (!st) return [];
    var out = st.rules.slice();
    if (opts && opts.extraLamp && st.extraLampRules) out = out.concat(st.extraLampRules);
    return out.map(function (r) { return { ch: r.ch, type: r.type, p1: r.p1, p2: r.p2, en: r.en }; });
  }

  function validDays(profile, days) {
    if (!days || days.length !== profile.stages.length || days[0] !== 0) return false;
    for (var i = 1; i < days.length; i++) {
      if (typeof days[i] !== 'number' || days[i] % 1 !== 0 || days[i] <= days[i - 1] || days[i] > 365) return false;
    }
    return true;
  }

  function daysSince(startedAtIso, nowMs) {
    var t = new Date(startedAtIso).getTime();
    if (!isFinite(t) || !isFinite(nowMs)) return null;
    return Math.max(0, (nowMs - t) / DAY_MS);
  }

  // ---------- สถานะหน้าเว็บ ----------

  var active = null;       // { id, stageIdx, extraLamp }
  var daysOverrides = {};  // { id: [0, d1, d2...] }
  var airTemp = null;
  var selectedId = 'psb';
  var els = {};

  function toast(msg, type, ms) {
    if (typeof showToast === 'function') showToast(msg, type || 'info', ms || 2500);
  }

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function currentDays() {
    var b = window.PhaseUI && window.PhaseUI.getBatch ? window.PhaseUI.getBatch() : null;
    return b ? daysSince(b.startedAt, Date.now()) : null;
  }

  function ruleLine(r) {
    var label = window.ScheduleUI && window.ScheduleUI.channelLabel ? window.ScheduleUI.channelLabel(r.ch) : 'CH ' + r.ch;
    var desc = window.ScheduleUI && window.ScheduleUI.describeRule ? window.ScheduleUI.describeRule(r) : '';
    if (r.type === 'I' && r.p1 === 1440 && r.p2 === 1440) desc = 'เปิดตลอด 24 ชม.';
    return label + ': ' + desc + (r.en ? '' : ' (ปิดใช้งาน)');
  }

  function rulesText(list) {
    return list.length ? list.map(ruleLine).join('\n') : '(ไม่มีกฎ)';
  }

  function applyStage(id, stageIdx, extraLamp, reason) {
    var p = PROFILES[id];
    if (!p || !window.ScheduleUI) { toast('ระบบตั้งเวลายังไม่พร้อม', 'error'); return false; }
    var current = window.ScheduleUI.getRules();
    var next = rulesFor(p, stageIdx, { extraLamp: extraLamp });
    lsSet(LS_PREV, { savedAt: new Date().toISOString(), rules: current });
    var ok = window.ScheduleUI.replaceRules(next, reason || ('ตั้งตารางเวลาตามสูตร "' + p.name + '" แล้ว'));
    if (!ok) { toast('ตารางของสูตรนี้ไม่ผ่านการตรวจรูปแบบ ไม่ได้แก้อะไร', 'error', 4000); return false; }
    active = { id: id, stageIdx: stageIdx, extraLamp: !!extraLamp };
    lsSet(LS_ACTIVE, active);
    render();
    return true;
  }

  function onApply() {
    var p = PROFILES[selectedId];
    var days = currentDays();
    var idx = days === null ? 0 : stageAt(p, days, daysOverrides[selectedId]);
    var extra = !!(els.extraLamp && els.extraLamp.checked);
    var next = rulesFor(p, idx, { extraLamp: extra });
    var current = window.ScheduleUI ? window.ScheduleUI.getRules() : [];
    var msg = 'ใช้สูตร "' + p.name + '" ระยะ "' + p.stages[idx].name + '"\n\n' +
      'ตารางเวลาเดิมจะถูกแทนที่ทั้งหมด และบอร์ดจะสั่งไฟ/ปั๊มตามตารางใหม่ภายใน ~15 วินาที\n\n' +
      '--- ตารางเดิม ---\n' + rulesText(current) + '\n\n--- ตารางใหม่ ---\n' + rulesText(next) +
      '\n\n(เก็บตารางเดิมไว้ กดคืนค่าได้ภายหลัง)';
    if (!window.confirm(msg)) return;
    applyStage(selectedId, idx, extra);
  }

  function onRestore() {
    var prev = lsGet(LS_PREV);
    if (!prev || !prev.rules || !window.ScheduleUI) { toast('ไม่มีตารางเดิมที่เก็บไว้', 'error'); return; }
    if (!window.confirm('คืนตารางเวลาเป็นค่าก่อนใช้สูตร?\n\n' + rulesText(prev.rules))) return;
    if (window.ScheduleUI.replaceRules(prev.rules, 'คืนตารางเวลาเดิมแล้ว')) {
      active = null;
      lsDel(LS_ACTIVE);
      render();
    } else {
      toast('คืนตารางเวลาไม่สำเร็จ', 'error');
    }
  }

  function onForget() {
    if (!active) return;
    if (!window.confirm('เลิกติดตามสูตรนี้? (ตารางเวลาที่ตั้งไว้ยังอยู่ ไม่ถูกลบ)')) return;
    active = null;
    lsDel(LS_ACTIVE);
    render();
  }

  function onStageSwitch() {
    if (!active) return;
    var p = PROFILES[active.id];
    var days = currentDays();
    if (!p || days === null) return;
    var idx = stageAt(p, days, daysOverrides[active.id]);
    var next = rulesFor(p, idx, { extraLamp: active.extraLamp });
    var current = window.ScheduleUI ? window.ScheduleUI.getRules() : [];
    var msg = 'สลับเป็นระยะ "' + p.stages[idx].name + '"\n\nตารางเวลาปัจจุบันจะถูกแทนที่ (รวมถึงที่คุณแก้เองหลังใช้สูตร)\n\n' +
      '--- ตารางเดิม ---\n' + rulesText(current) + '\n\n--- ตารางใหม่ ---\n' + rulesText(next);
    if (!window.confirm(msg)) return;
    applyStage(active.id, idx, active.extraLamp, 'สลับตารางเวลาเป็นระยะ "' + p.stages[idx].name + '" แล้ว');
  }

  function saveDays() {
    var p = PROFILES[selectedId];
    var vals = [0];
    for (var i = 1; i < p.stages.length; i++) vals.push(parseInt(els.dayInputs[i].value, 10));
    if (!validDays(p, vals)) { toast('วันเริ่มระยะต้องเป็นจำนวนเต็มเรียงจากน้อยไปมาก (ไม่เกิน 365)', 'error', 3500); return; }
    daysOverrides[selectedId] = vals;
    lsSet(LS_DAYS, daysOverrides);
    render();
    toast('บันทึกวันเริ่มระยะแล้ว', 'success', 2000);
  }

  function resetDays() {
    delete daysOverrides[selectedId];
    lsSet(LS_DAYS, daysOverrides);
    render();
  }

  // ---------- การแสดงผล ----------

  function setText(el, t) { if (el) el.textContent = t; }

  function renderStages(p) {
    els.stages.innerHTML = '';
    var starts = startDays(p, daysOverrides[selectedId]);
    var days = currentDays();
    var curIdx = active && active.id === selectedId && days !== null ? stageAt(p, days, daysOverrides[selectedId]) : -1;
    p.stages.forEach(function (st, i) {
      var row = document.createElement('div');
      row.className = 'pr-stage' + (i === curIdx ? ' is-current' : '');
      var head = document.createElement('strong');
      head.textContent = (i + 1) + '. ' + st.name + ' — เริ่มวันที่ ' + starts[i];
      var temp = document.createElement('span');
      temp.textContent = 'อุณหภูมิอากาศที่แนะนำ ' + st.temp[0] + '–' + st.temp[1] + ' °C';
      var rules = document.createElement('span');
      rules.className = 'pr-rules';
      rules.textContent = rulesFor(p, i, {}).map(ruleLine).join(' • ');
      row.appendChild(head); row.appendChild(temp); row.appendChild(rules);
      if (st.extraLampNote) {
        var xl = document.createElement('span');
        xl.className = 'pr-rules';
        xl.textContent = 'ตัวเลือก: ' + st.extraLampNote + ' (ติ๊ก "มีหลอดเสริมที่ CH 4" ด้านล่าง)';
        row.appendChild(xl);
      }
      els.stages.appendChild(row);
    });
  }

  function renderDayInputs(p) {
    els.daysBox.innerHTML = '';
    els.dayInputs = [];
    var starts = startDays(p, daysOverrides[selectedId]);
    els.daysDetails.style.display = p.stages.length > 1 ? 'block' : 'none';
    p.stages.forEach(function (st, i) {
      if (i === 0) { els.dayInputs.push(null); return; }
      var lbl = document.createElement('label');
      lbl.className = 'pr-lbl';
      lbl.textContent = 'ระยะ ' + (i + 1) + ' เริ่มวันที่ ';
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.max = '365'; inp.value = starts[i];
      inp.setAttribute('inputmode', 'numeric');
      lbl.appendChild(inp);
      els.daysBox.appendChild(lbl);
      els.dayInputs.push(inp);
    });
  }

  function render() {
    if (!els.section) return;
    var p = PROFILES[selectedId];
    setText(els.desc, p.desc);
    setText(els.sci, p.sci);
    renderStages(p);
    renderDayInputs(p);

    var hasExtra = p.stages.some(function (s) { return !!s.extraLampRules; });
    els.extraRow.style.display = hasExtra ? 'flex' : 'none';

    // สถานะสูตรที่ใช้อยู่
    var days = currentDays();
    if (active && PROFILES[active.id]) {
      var ap = PROFILES[active.id];
      var curIdx = days === null ? active.stageIdx : stageAt(ap, days, daysOverrides[active.id]);
      setText(els.current, 'สูตรที่ใช้อยู่: ' + ap.name + ' — ระยะ ' + (active.stageIdx + 1) + ' "' + ap.stages[active.stageIdx].name + '"' +
        (days !== null ? ' (วันที่ ' + Math.floor(days) + ' ของรอบ)' : ' (ยังไม่เริ่มรอบเพาะเลี้ยง)'));
      var due = days !== null && curIdx !== active.stageIdx;
      els.stageBanner.style.display = due ? 'block' : 'none';
      if (due) setText(els.stageBannerText, 'ถึงระยะ ' + (curIdx + 1) + ' "' + ap.stages[curIdx].name + '" แล้ว แต่ตารางเวลายังเป็นของระยะ ' + (active.stageIdx + 1) + ' (ต้องกดสลับเอง เพราะการสลับอัตโนมัติยังต้องเปิดหน้าเว็บ)');

      // อุณหภูมิอากาศเทียบช่วงของระยะที่ใช้อยู่
      var st = ap.stages[Math.min(active.stageIdx, ap.stages.length - 1)];
      var ts = tempStatus(st.temp, airTemp);
      var tt = ts === null ? 'ยังไม่มีค่าอุณหภูมิ' :
        ts === 'ok' ? 'อยู่ในช่วงที่แนะนำ' : ts === 'low' ? 'ต่ำกว่าช่วงที่แนะนำ' : 'สูงกว่าช่วงที่แนะนำ';
      setText(els.temp, 'อุณหภูมิอากาศ (DHT ไม่ใช่อุณหภูมิน้ำ): ' + (airTemp !== null ? airTemp.toFixed(1) + ' °C' : '-') +
        ' — ' + tt + ' (' + st.temp[0] + '–' + st.temp[1] + ' °C)');
      els.temp.className = 'pr-temp' + (ts === 'low' || ts === 'high' ? ' is-warn' : '');
      els.temp.style.display = 'block';
      els.forgetBtn.style.display = 'inline-block';
    } else {
      setText(els.current, 'ยังไม่ได้ใช้สูตร — ตารางเวลาและการ์ดเฟส PSB ทำงานตามเดิม');
      els.stageBanner.style.display = 'none';
      els.temp.style.display = 'none';
      els.forgetBtn.style.display = 'none';
    }
    els.restoreBtn.disabled = !lsGet(LS_PREV);

    syncPhaseCard();
  }

  // การ์ดเฟส PSB และป้ายสีเป็นของ PSB เท่านั้น: ซ่อนเมื่อสูตรที่ใช้ไม่ใช่ PSB และกันการมาร์ก/บันทึกสีปน
  function syncPhaseCard() {
    var phaseSection = document.getElementById('phaseSection');
    var nonPsb = !!(active && PROFILES[active.id] && !PROFILES[active.id].hasPhaseCard);
    if (phaseSection) phaseSection.style.display = nonPsb ? 'none' : '';
    if (window.PhaseUI && window.PhaseUI.setMarkingBlocked) {
      window.PhaseUI.setMarkingBlocked(nonPsb ? 'สูตรที่ใช้ไม่ใช่ PSB: ปิดการมาร์กสีและบันทึกประวัติสี เพราะป้ายปรับเทียบเป็นของ PSB' : '', 'profile');
    }
    setText(els.phaseNote, nonPsb ? 'การ์ดเฟส PSB ถูกซ่อนไว้ เพราะสูตรที่ใช้ไม่ใช่ PSB' : '');
    els.phaseNote.style.display = nonPsb ? 'block' : 'none';
  }

  // เรียกจาก app.js ทุกครั้งที่ได้ข้อมูลอุปกรณ์จาก Supabase
  function onCloudData(dev) {
    if (!dev) return;
    var t = Number(dev.temperature);
    airTemp = dev.temperature === null || dev.temperature === undefined || !isFinite(t) ? null : t;
    render();
  }

  function init() {
    els = {
      section: document.getElementById('profileSection'),
      select: document.getElementById('prSelect'),
      sci: document.getElementById('prSci'),
      desc: document.getElementById('prDesc'),
      stages: document.getElementById('prStages'),
      extraRow: document.getElementById('prExtraRow'),
      extraLamp: document.getElementById('prExtraLamp'),
      applyBtn: document.getElementById('prApplyBtn'),
      restoreBtn: document.getElementById('prRestoreBtn'),
      forgetBtn: document.getElementById('prForgetBtn'),
      current: document.getElementById('prCurrent'),
      stageBanner: document.getElementById('prStageBanner'),
      stageBannerText: document.getElementById('prStageBannerText'),
      stageSwitchBtn: document.getElementById('prStageSwitchBtn'),
      temp: document.getElementById('prTemp'),
      phaseNote: document.getElementById('prPhaseNote'),
      daysDetails: document.getElementById('prDaysDetails'),
      daysBox: document.getElementById('prDaysBox'),
      daysSave: document.getElementById('prDaysSave'),
      daysReset: document.getElementById('prDaysReset'),
      dayInputs: []
    };
    if (!els.section) return;

    var saved = lsGet(LS_ACTIVE);
    if (saved && PROFILES[saved.id] && saved.stageIdx >= 0 && saved.stageIdx < PROFILES[saved.id].stages.length) active = saved;
    var d = lsGet(LS_DAYS);
    if (d && typeof d === 'object') {
      Object.keys(d).forEach(function (id) { if (PROFILES[id] && validDays(PROFILES[id], d[id])) daysOverrides[id] = d[id]; });
    }
    if (active) selectedId = active.id;

    ORDER.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = PROFILES[id].name;
      els.select.appendChild(opt);
    });
    els.select.value = selectedId;
    els.select.addEventListener('change', function () { selectedId = els.select.value; render(); });
    els.applyBtn.addEventListener('click', onApply);
    els.restoreBtn.addEventListener('click', onRestore);
    els.forgetBtn.addEventListener('click', onForget);
    els.stageSwitchBtn.addEventListener('click', onStageSwitch);
    els.daysSave.addEventListener('click', saveDays);
    els.daysReset.addEventListener('click', resetDays);

    render();
    setInterval(render, 60000); // อัปเดตวันที่/ระยะ
  }

  window.ProfileUI = {
    onCloudData: onCloudData,
    // เปิดไว้ให้ทดสอบ
    _test: { PROFILES: PROFILES, ORDER: ORDER, stageAt: stageAt, tempStatus: tempStatus, rulesFor: rulesFor, validDays: validDays, daysSince: daysSince }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
