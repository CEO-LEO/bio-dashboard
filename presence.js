/**
 * ตัวบอกสถานะบอร์ดออนไลน์/ออฟไลน์ จาก last_seen_at ของ esp32_devices (id = 1)
 *
 * last_seen_at ถูกตั้งด้วย trigger ในฐานข้อมูลเฉพาะเมื่อมีการเขียนค่า color_*, temperature
 * หรือ humidity (คือบอร์ดส่งข้อมูลเซนเซอร์) ส่วน updated_at ถูกตั้งทุกครั้งที่แถวถูกอัปเดต
 * รวมถึงที่เว็บเขียนเอง จึงไม่ใช้ตัดสินสถานะบอร์ด (ไม่อ่านมาใช้เลย)
 *
 *   ออนไลน์   : last_seen_at ไม่เกิน 3 นาที
 *   ช้า       : เกิน 3 ถึง 10 นาที
 *   ออฟไลน์   : เกิน 10 นาที
 *   ยังไม่เคยเห็น : last_seen_at เป็น null หรือยังไม่มีคอลัมน์ — ยังไม่มีข้อมูลให้ตัดสิน
 *                   (ไม่ถือว่าออฟไลน์ ไม่ปิดการมาร์กสี)
 *   ไม่ทราบ   : อ่านวันที่ไม่ได้ หรือเวลาอยู่ในอนาคตเกิน 60 วินาที (นาฬิกาเครื่องผู้ใช้อาจเพี้ยน)
 */
(function () {
  'use strict';

  var ONLINE_MAX_SEC = 3 * 60;
  var SLOW_MAX_SEC = 10 * 60;
  var FUTURE_TOLERANCE_SEC = 60;
  var TICK_MS = 15000;

  var STATUS_LABEL = { online: 'ออนไลน์', slow: 'ช้า/น่าสงสัย', offline: 'ออฟไลน์', never: 'ยังไม่เคยเห็นบอร์ด', unknown: 'ไม่ทราบสถานะ' };
  var NEVER_NOTE = 'ยังไม่มีเวลาที่บอร์ดส่งข้อมูล (last_seen_at) จึงยังตัดสินสถานะไม่ได้';

  // ---------- ฟังก์ชันคำนวณ (pure) ----------

  /**
   * lastSeenIso: ค่า last_seen_at จาก Supabase (null/undefined = ยังไม่เคยเห็น) , nowMs: Date.now()
   * คืน { status: 'online'|'slow'|'offline'|'never'|'unknown', ageSec: จำนวนวินาทีที่ผ่านไป หรือ null }
   */
  function presenceOf(lastSeenIso, nowMs) {
    if (lastSeenIso === null || lastSeenIso === undefined || lastSeenIso === '') {
      return { status: 'never', ageSec: null };
    }
    var t = typeof lastSeenIso === 'number' ? lastSeenIso : new Date(lastSeenIso).getTime();
    if (!isFinite(t) || typeof nowMs !== 'number' || !isFinite(nowMs)) {
      return { status: 'unknown', ageSec: null };
    }
    var ageSec = (nowMs - t) / 1000;
    if (ageSec < 0) {
      if (-ageSec <= FUTURE_TOLERANCE_SEC) return { status: 'online', ageSec: 0 };
      return { status: 'unknown', ageSec: null };
    }
    ageSec = Math.floor(ageSec);
    if (ageSec <= ONLINE_MAX_SEC) return { status: 'online', ageSec: ageSec };
    if (ageSec <= SLOW_MAX_SEC) return { status: 'slow', ageSec: ageSec };
    return { status: 'offline', ageSec: ageSec };
  }

  // "เห็นล่าสุดเมื่อ X วินาที/นาที/ชั่วโมงที่แล้ว" ; ไม่ทราบเวลา -> "ยังไม่เคยเห็นข้อมูล"
  function lastSeenText(ageSec) {
    if (ageSec === null || ageSec === undefined || !isFinite(ageSec) || ageSec < 0) return 'ยังไม่เคยเห็นข้อมูลจากบอร์ด';
    var s = Math.floor(ageSec);
    if (s < 60) return 'เห็นล่าสุดเมื่อ ' + s + ' วินาทีที่แล้ว';
    if (s < 3600) return 'เห็นล่าสุดเมื่อ ' + Math.floor(s / 60) + ' นาทีที่แล้ว';
    return 'เห็นล่าสุดเมื่อ ' + Math.floor(s / 3600) + ' ชั่วโมงที่แล้ว';
  }

  // เหตุผลที่ปิดการมาร์กสี ; ว่าง = ไม่ต้องปิด (ปิดเฉพาะออฟไลน์)
  function markBlockReason(status) {
    return status === 'offline'
      ? 'ปิดการมาร์กสีชั่วคราว: บอร์ดออฟไลน์ ค่าสีที่เห็นอาจเป็นค่าเก่า การมาร์กจะทำให้ข้อมูลปรับเทียบผิด'
      : '';
  }

  // ---------- สถานะหน้าเว็บ ----------

  var lastSeen = null;      // ค่า last_seen_at ล่าสุดที่ได้รับ (null = ยังไม่เคยเห็น/ไม่มีคอลัมน์)
  var gotData = false;      // เคยได้รับข้อมูลอุปกรณ์จาก Cloud แล้วหรือยัง
  var els = {};

  function isCloudMode() {
    return typeof state !== 'undefined' && state.connMode === 'supabase';
  }

  function setText(el, text) { if (el) el.textContent = text; }

  function setPill(kind, label, age) {
    if (!els.badge) return;
    els.badge.className = 'presence-pill presence-' + kind;
    setText(els.label, label);
    setText(els.age, age || '');
  }

  function render() {
    if (!els.badge) return;

    if (!isCloudMode()) {
      setPill('nocloud', 'ไม่ได้เชื่อมต่อ Cloud', '');
      showStale(false);
      blockMarking('');
      return;
    }
    if (!gotData) {
      setPill('unknown', 'กำลังตรวจสอบบอร์ด...', '');
      showStale(false);
      blockMarking('');
      return;
    }

    var res = presenceOf(lastSeen, Date.now());
    if (res.status === 'never') {
      setPill('never', STATUS_LABEL.never, NEVER_NOTE);
      showStale(false);
      blockMarking('');
      return;
    }
    var ageText = res.status === 'unknown' ? 'นาฬิกาเครื่องอาจไม่ตรง' : lastSeenText(res.ageSec);
    setPill(res.status, STATUS_LABEL[res.status], ageText);
    els.badge.title = 'เทียบเวลาในเครื่องของคุณกับ last_seen_at (เวลาที่บอร์ดส่งข้อมูลเซนเซอร์ล่าสุด)';

    var stale = res.status === 'slow' || res.status === 'offline';
    showStale(stale, res.status === 'offline' ? 'บอร์ดออฟไลน์ — ' + ageText : 'บอร์ดส่งข้อมูลช้ากว่าปกติ — ' + ageText);
    blockMarking(markBlockReason(res.status));
  }

  function showStale(show, text) {
    if (!els.banner) return;
    els.banner.style.display = show ? 'block' : 'none';
    if (show) setText(els.bannerText, text);
  }

  function blockMarking(reason) {
    if (window.PhaseUI && typeof window.PhaseUI.setMarkingBlocked === 'function') window.PhaseUI.setMarkingBlocked(reason);
  }

  // เรียกจาก app.js ทุกครั้งที่ได้ข้อมูลอุปกรณ์จาก Supabase (ครั้งแรกและ Realtime)
  function onCloudData(dev) {
    if (!dev) return;
    gotData = true;
    // ไม่มีคอลัมน์ last_seen_at ก็ได้ค่า undefined -> ถือเป็น null (ยังไม่เคยเห็น)
    lastSeen = dev.last_seen_at === undefined ? null : dev.last_seen_at;
    render();
  }

  function init() {
    els = {
      badge: document.getElementById('presenceBadge'),
      label: document.getElementById('presenceLabel'),
      age: document.getElementById('presenceAge'),
      banner: document.getElementById('presenceStaleBanner'),
      bannerText: document.getElementById('presenceStaleText')
    };
    if (!els.badge) return;
    render();
    setInterval(render, TICK_MS); // นับเวลาต่อเองโดยไม่ต้องรอข้อมูลใหม่
  }

  window.PresenceUI = {
    onCloudData: onCloudData,
    // เปิดไว้ให้ทดสอบ
    _test: { presenceOf: presenceOf, lastSeenText: lastSeenText, markBlockReason: markBlockReason }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
