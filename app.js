/**
 * ESP32 Smart Controller & IoT Dashboard
 * Supports: Supabase Cloud (GitHub Pages) + Direct Local IP + Demo Mode
 */

// --- Application State ---
const state = {
  // Connection Mode: 'supabase' (Cloud) or 'local' (WiFi Direct)
  connMode: (localStorage.getItem('esp32_conn_mode') === 'local') ? 'local' : 'supabase',
  
  // Supabase Credentials (ใช้โปรเจกต์เดิมเป็นค่าเริ่มต้น)
  supabaseUrl: localStorage.getItem('supabase_url') || 'https://fgkhnqqxrvfoluvjacnz.supabase.co',
  supabaseKey: localStorage.getItem('supabase_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2hucXF4cnZmb2x1dmphY256Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNTA4NzIsImV4cCI6MjEwODkyNjg3Mn0.OGoF2a1mYKn3DMf20A21QibNp9JcJyd3bSXF-EQ2tM4',
  supabaseClient: null,
  realtimeChannel: null,

  // Local IP Config
  espIp: localStorage.getItem('esp32_ip') || '192.168.1.47',
  pollIntervalMs: parseInt(localStorage.getItem('esp32_interval') || '2000', 10),

  // Demo Mode (ปิดถาวรตามคำขอ เชื่อมต่อฮาร์ดแวร์จริง 100%)
  isDemoMode: false,
  theme: localStorage.getItem('esp32_theme') || 'light',

  // Status & Telemetry
  isConnected: false,
  isFetching: false,
  lastPingMs: 0,
  lastUpdated: null,

  // Device Telemetry (Device 1)
  relays: [false, false, false, false],
  dht: {
    temp: 28.5,
    hum: 62.0
  },
  color: {
    r: 59,
    g: 130,
    b: 246,
    c: 1200,
    hex: '#3B82F6'
  },
  sensorLed: true,

};

// User interaction lockouts to prevent stale in-flight packets from bouncing switch states
const lastUserRelayActionTime = [0, 0, 0, 0];
let lastUserLedActionTime = 0;
let lastTelemetrySyncTime = 0;

let pollTimer = null;
let consecutiveFailures = 0;

// --- DOM Elements ---
const elements = {
  html: document.documentElement,
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  connectionStatusBadge: document.getElementById('connectionStatusBadge'),
  connectionStatusText: document.getElementById('connectionStatusText'),
  lastUpdated: document.getElementById('lastUpdated'),
  pingValue: document.getElementById('pingValue'),
  syncModeLabel: document.getElementById('syncModeLabel'),

  // Tabs & Settings
  tabSupabase: document.getElementById('tabSupabase'),
  tabLocal: document.getElementById('tabLocal'),
  panelSupabase: document.getElementById('panelSupabase'),
  panelLocal: document.getElementById('panelLocal'),
  demoModeToggle: document.getElementById('demoModeToggle'),

  // Supabase Fields
  supabaseUrlInput: document.getElementById('supabaseUrlInput'),
  supabaseKeyInput: document.getElementById('supabaseKeyInput'),
  saveSupabaseBtn: document.getElementById('saveSupabaseBtn'),
  cloudRefreshBtn: document.getElementById('cloudRefreshBtn'),

  // Local IP Fields
  espIpInput: document.getElementById('espIpInput'),
  saveConnectBtn: document.getElementById('saveConnectBtn'),
  manualRefreshBtn: document.getElementById('manualRefreshBtn'),

  // Relays
  masterAllOnBtn: document.getElementById('masterAllOnBtn'),
  masterAllOffBtn: document.getElementById('masterAllOffBtn'),
  relayCards: [
    document.getElementById('relayCard-1'),
    document.getElementById('relayCard-2'),
    document.getElementById('relayCard-3'),
    document.getElementById('relayCard-4')
  ],
  relaySwitches: [
    document.getElementById('relaySwitch-1'),
    document.getElementById('relaySwitch-2'),
    document.getElementById('relaySwitch-3'),
    document.getElementById('relaySwitch-4')
  ],
  relayStatusTexts: [
    document.getElementById('relayStatusText-1'),
    document.getElementById('relayStatusText-2'),
    document.getElementById('relayStatusText-3'),
    document.getElementById('relayStatusText-4')
  ],

  // DHT22
  tempValue: document.getElementById('tempValue'),
  tempStatusBadge: document.getElementById('tempStatusBadge'),
  tempBar: document.getElementById('tempBar'),
  humValue: document.getElementById('humValue'),
  humStatusBadge: document.getElementById('humStatusBadge'),
  humBar: document.getElementById('humBar'),
  randomDhtBtn: document.getElementById('randomDhtBtn'),

  // Color Sensor & Sensor LED
  sensorLedToggle: document.getElementById('sensorLedToggle'),
  sensorLedStatusText: document.getElementById('sensorLedStatusText'),
  colorPreviewBox: document.getElementById('colorPreviewBox'),
  previewHexBadge: document.getElementById('previewHexBadge'),
  hexCodeDisplay: document.getElementById('hexCodeDisplay'),
  btnHexLabel: document.getElementById('btnHexLabel'),
  colorNameEstimate: document.getElementById('colorNameEstimate'),
  copyHexBtn: document.getElementById('copyHexBtn'),
  randomColorBtn: document.getElementById('randomColorBtn'),
  valRed: document.getElementById('valRed'),
  barRed: document.getElementById('barRed'),
  valGreen: document.getElementById('valGreen'),
  barGreen: document.getElementById('barGreen'),
  valBlue: document.getElementById('valBlue'),
  barBlue: document.getElementById('barBlue'),
  valClear: document.getElementById('valClear'),
  barClear: document.getElementById('barClear'),

  // Toast
  toastContainer: document.getElementById('toastContainer')
};

// --- Initialization ---
function initApp() {
  applyTheme(state.theme);

  // Clear demo mode stored in localStorage
  localStorage.removeItem('esp32_demo');
  state.isDemoMode = false;

  // Restore inputs
  elements.supabaseUrlInput.value = state.supabaseUrl;
  elements.supabaseKeyInput.value = state.supabaseKey;
  elements.espIpInput.value = state.espIp;
  if (elements.demoModeToggle) elements.demoModeToggle.checked = false;

  // Set initial Tab
  setConnectionTab(state.connMode);

  // Attach Event Listeners
  setupEventListeners();

  // Render initial UI
  updateConnectionBadge('loading');
  renderRelays();
  renderDHT();
  renderColorSensor();

  // Setup Connection
  setupPolling();

  if (state.connMode === 'supabase' && state.supabaseUrl && state.supabaseKey) {
    initSupabaseClient();
  } else if (state.connMode === 'local' && state.espIp) {
    fetchLocalData();
  } else {
    updateConnectionBadge('disconnected');
  }
}

// --- Tabs Management ---
function setConnectionTab(mode) {
  state.connMode = mode;
  localStorage.setItem('esp32_conn_mode', mode);

  if (elements.tabSupabase) elements.tabSupabase.classList.toggle('active', mode === 'supabase');
  if (elements.tabLocal) elements.tabLocal.classList.toggle('active', mode === 'local');

  if (elements.panelSupabase) elements.panelSupabase.style.display = mode === 'supabase' ? 'block' : 'none';
  if (elements.panelLocal) elements.panelLocal.style.display = mode === 'local' ? 'block' : 'none';

  if (mode === 'supabase') {
    elements.syncModeLabel.textContent = 'Supabase Realtime (WSS)';
    if (!state.supabaseClient) initSupabaseClient();
  } else {
    elements.syncModeLabel.textContent = 'HTTP Fetch (Local LAN)';
  }

  setupPolling();
}

// --- Event Listeners ---
function setupEventListeners() {
  // Theme Toggle
  elements.themeToggleBtn.addEventListener('click', () => {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });

  // Tab Switching
  if (elements.tabSupabase) elements.tabSupabase.addEventListener('click', () => setConnectionTab('supabase'));
  if (elements.tabLocal) elements.tabLocal.addEventListener('click', () => setConnectionTab('local'));

  // Demo Mode Switch (if exists in DOM)
  if (elements.demoModeToggle) {
    elements.demoModeToggle.addEventListener('change', (e) => {
      state.isDemoMode = e.target.checked;
      vibrate(30);

      if (state.isDemoMode) {
        enableDemoMode();
      } else {
        updateConnectionBadge('loading');
        if (state.connMode === 'supabase') {
          if (!state.supabaseUrl || !state.supabaseKey) {
            showToast('กรุณากรอก Supabase URL และ Anon Key ก่อนเชื่อมต่อ', 'error');
            updateConnectionBadge('disconnected');
            return;
          }
          initSupabaseClient();
        } else {
          showToast(`กำลังเชื่อมต่อ ESP32 Local: ${state.espIp}`, 'info');
          fetchLocalData();
        }
      }
    });
  }

  // Clicking Status Badge will re-attempt connection
  if (elements.connectionStatusBadge) {
    elements.connectionStatusBadge.addEventListener('click', () => {
      vibrate(30);
      if (!state.isConnected) {
        updateConnectionBadge('loading');
        if (state.connMode === 'supabase') {
          initSupabaseClient();
        } else {
          fetchLocalData();
        }
      }
    });
  }

  // Save Supabase & Connect
  elements.saveSupabaseBtn.addEventListener('click', async () => {
    const url = elements.supabaseUrlInput.value.trim().replace(/\/$/, '');
    const key = elements.supabaseKeyInput.value.trim();

    if (!url || !key) {
      showToast('กรุณากรอกทั้ง Supabase URL และ Anon Public Key', 'error');
      return;
    }

    state.supabaseUrl = url;
    state.supabaseKey = key;
    localStorage.setItem('supabase_url', url);
    localStorage.setItem('supabase_key', key);
    vibrate(40);

    // Visual button feedback
    const originalHtml = elements.saveSupabaseBtn.innerHTML;
    elements.saveSupabaseBtn.disabled = true;
    elements.saveSupabaseBtn.innerHTML = `<span>กำลังเชื่อมต่อ Cloud...</span>`;

    const success = await initSupabaseClient();
    elements.saveSupabaseBtn.disabled = false;
    elements.saveSupabaseBtn.innerHTML = originalHtml;

    if (success) {
      state.isDemoMode = false;
      if (elements.demoModeToggle) elements.demoModeToggle.checked = false;
      localStorage.removeItem('esp32_demo');
      showToast('✅ เชื่อมต่อ Cloud สำเร็จเรียบร้อยแล้ว!', 'success');
    }
  });

  // Cloud Refresh Button
  elements.cloudRefreshBtn.addEventListener('click', async () => {
    vibrate(25);
    const icon = elements.cloudRefreshBtn.querySelector('.refresh-icon');
    if (icon) icon.classList.add('spinning');
    await fetchSupabaseData(true);
    if (icon) icon.classList.remove('spinning');
  });

  // Local Save IP & Test Connection
  elements.saveConnectBtn.addEventListener('click', async () => {
    let rawIp = elements.espIpInput.value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!rawIp) {
      showToast('กรุณาระบุ IP Address ของ ESP32', 'error');
      return;
    }
    state.espIp = rawIp;
    localStorage.setItem('esp32_ip', rawIp);
    vibrate(40);

    const originalBtnHtml = elements.saveConnectBtn.innerHTML;
    elements.saveConnectBtn.disabled = true;
    elements.saveConnectBtn.innerHTML = `<span>กำลังทดสอบ...</span>`;

    try {
      const signal = (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal)
        ? AbortSignal.timeout(2000)
        : null;

      const res = await fetch(`http://${state.espIp}/api/data`, {
        method: 'GET',
        signal: signal,
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });

      if (res.ok) {
        const json = await res.json();
        processLocalApiData(json);
        state.isDemoMode = false;
        if (elements.demoModeToggle) elements.demoModeToggle.checked = false;
        localStorage.removeItem('esp32_demo');
        consecutiveFailures = 0;
        state.isConnected = true;
        updateConnectionBadge('connected');
        showToast(`✅ เชื่อมต่อกับ ESP32 (${state.espIp}) สำเร็จแล้ว!`, 'success');
      } else {
        throw new Error('Response not OK');
      }
    } catch (e) {
      state.isConnected = false;
      updateConnectionBadge('disconnected');
      showToast(`⚠️ ไม่พบ ESP32 ที่ IP: ${state.espIp}`, 'error', 4000);
    } finally {
      elements.saveConnectBtn.disabled = false;
      elements.saveConnectBtn.innerHTML = originalBtnHtml;
    }
  });

  // Local Refresh Button
  elements.manualRefreshBtn.addEventListener('click', () => {
    vibrate(25);
    const icon = elements.manualRefreshBtn.querySelector('.refresh-icon');
    if (icon) icon.classList.add('spinning');
    if (state.isDemoMode) {
      simulateRandomFluctuation();
      renderDHT();
      renderColorSensor();
      updateLastUpdatedTime();
      setTimeout(() => { if (icon) icon.classList.remove('spinning'); }, 200);
    } else {
      fetchLocalData().finally(() => { if (icon) icon.classList.remove('spinning'); });
    }
  });

  // Individual Relay Switches
  elements.relaySwitches.forEach((toggleEl, idx) => {
    toggleEl.addEventListener('change', (e) => {
      const channel = idx + 1;
      const targetState = e.target.checked;
      vibrate(40);
      handleRelayToggle(channel, targetState);
    });
  });

  // Master Buttons
  elements.masterAllOnBtn.addEventListener('click', () => {
    vibrate([40, 30, 40]);
    handleMasterAll(true);
  });

  elements.masterAllOffBtn.addEventListener('click', () => {
    vibrate([40, 30, 40]);
    handleMasterAll(false);
  });

  // Copy HEX Color Code
  elements.copyHexBtn.addEventListener('click', copyHexToClipboard);

  // Random Color Button (Demo)
  if (elements.randomColorBtn) {
    elements.randomColorBtn.addEventListener('click', () => {
      vibrate(30);
      randomizeColor();
      showToast(`สุ่มสีใหม่: ${state.color.hex}`, 'info');
    });
  }

  // Sensor White LED Toggle Switch
  if (elements.sensorLedToggle) {
    elements.sensorLedToggle.addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      lastUserLedActionTime = Date.now();
      state.sensorLed = isChecked;
      if (elements.sensorLedStatusText) {
        elements.sensorLedStatusText.textContent = isChecked ? 'เปิด' : 'ปิด';
      }
      vibrate(30);

      if (state.isDemoMode) {
        showToast(`ไฟ LED ส่องสี: ${isChecked ? 'เปิด (ON)' : 'ปิด (OFF)'}`, isChecked ? 'success' : 'info', 1800);
        return;
      }

      if (state.connMode === 'supabase' && state.supabaseClient) {
        try {
          const val = isChecked ? 'led_on' : 'led_off';
          const { error } = await state.supabaseClient
            .from('esp32_devices')
            .update({ name: val, updated_at: new Date().toISOString() })
            .eq('id', 1);

          if (!error) {
            showToast(`💡 สั่ง${isChecked ? 'เปิด' : 'ปิด'}ไฟ LED เซนเซอร์สีสำเร็จ`, 'success');
          }
        } catch (err) {
          console.error('Error toggling sensor LED:', err);
        }
      }
    });
  }

  // Random/Test DHT22 Temperature & Humidity Button
  if (elements.randomDhtBtn) {
    elements.randomDhtBtn.addEventListener('click', async () => {
      vibrate(30);
      const newT = parseFloat((25.0 + Math.random() * 8.0).toFixed(1));
      const newH = parseFloat((50.0 + Math.random() * 30.0).toFixed(1));

      if (state.isDemoMode) {
        state.dht.temp = newT;
        state.dht.hum = newH;
        renderDHT();
        updateLastUpdatedTime();
        showToast(`อัปเดตอุณหภูมิ: ${newT} °C | ความชื้น: ${newH} %`, 'info');
      } else if (state.connMode === 'supabase' && state.supabaseClient) {
        showToast(`กำลังส่งค่าอุณหภูมิ ${newT} °C ไปยัง Supabase...`, 'info');
        try {
          const { error } = await state.supabaseClient
            .from('esp32_devices')
            .update({ temperature: newT, humidity: newH, updated_at: new Date().toISOString() })
            .eq('id', 1);

          if (!error) {
            showToast(`✅ อัปเดตไปยัง Cloud สำเร็จ: ${newT} °C`, 'success');
          }
        } catch (e) {
          console.error(e);
        }
      }
    });
  }
}

// --- Supabase Cloud Client & Realtime Subscription ---
async function initSupabaseClient() {
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    showToast('กำลังโหลด Supabase SDK...', 'info');
    return false;
  }

  try {
    state.supabaseClient = window.supabase.createClient(state.supabaseUrl, state.supabaseKey);

    // Initial Fetch from Table
    const { data, error } = await state.supabaseClient
      .from('esp32_devices')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) {
      console.error('Supabase query error:', error);
      showToast(`เชื่อมต่อ Supabase ไม่สำเร็จ: ${error.message}`, 'error', 6000);
      state.isConnected = false;
      updateConnectionBadge('disconnected');
      return false;
    }

    if (data) {
      applyDeviceDataFromSupabase(data);
      state.isConnected = true;
      updateConnectionBadge('cloud');
      elements.pingValue.textContent = 'Realtime (WSS)';
    }

    // Subscribe to Realtime Postgres Changes
    if (state.realtimeChannel) {
      state.supabaseClient.removeChannel(state.realtimeChannel);
    }

    state.realtimeChannel = state.supabaseClient
      .channel('esp32-realtime-room')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'esp32_devices', filter: 'id=eq.1' },
        (payload) => {
          if (payload.new) {
            applyDeviceDataFromSupabase(payload.new);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          updateConnectionBadge('cloud');
          elements.pingValue.textContent = 'Realtime (WSS)';
        }
      });

    return true;
  } catch (err) {
    console.error('Init Supabase Client failed:', err);
    showToast('เกิดข้อผิดพลาดในการเริ่มต้น Supabase Client', 'error');
    state.isConnected = false;
    updateConnectionBadge('disconnected');
    return false;
  }
}

// --- Hybrid Supabase Table Auto-Sync Helper ---
function getSupabaseClient() {
  if (state.supabaseClient) return state.supabaseClient;
  if (typeof window.supabase !== 'undefined' && window.supabase.createClient && state.supabaseUrl && state.supabaseKey) {
    try {
      state.supabaseClient = window.supabase.createClient(state.supabaseUrl, state.supabaseKey);
      return state.supabaseClient;
    } catch (e) {
      console.warn('Failed to init Supabase client:', e);
    }
  }
  return null;
}

let pendingSyncTimeout = null;
let pendingSyncData = {};

function syncToSupabase(data, debounceMs = 0) {
  if (state.isDemoMode) return;
  const client = getSupabaseClient();
  if (!client) return;

  Object.assign(pendingSyncData, data);

  if (debounceMs === 0) {
    if (pendingSyncTimeout) {
      clearTimeout(pendingSyncTimeout);
      pendingSyncTimeout = null;
    }
    const toSend = { ...pendingSyncData, updated_at: new Date().toISOString() };
    pendingSyncData = {};
    client.from('esp32_devices').update(toSend).eq('id', 1).then(({ error }) => {
      if (error) console.warn('[Supabase Auto-Sync Error]', error.message);
      else console.log('[Supabase Auto-Synced to Table]', toSend);
    }).catch(err => console.warn('[Supabase Auto-Sync Exception]', err));
  } else {
    if (pendingSyncTimeout) clearTimeout(pendingSyncTimeout);
    pendingSyncTimeout = setTimeout(() => {
      pendingSyncTimeout = null;
      const toSend = { ...pendingSyncData, updated_at: new Date().toISOString() };
      pendingSyncData = {};
      client.from('esp32_devices').update(toSend).eq('id', 1).then(({ error }) => {
        if (error) console.warn('[Supabase Debounced Sync Error]', error.message);
        else console.log('[Supabase Debounced Synced to Table]', toSend);
      }).catch(err => console.warn('[Supabase Debounced Sync Exception]', err));
    }, debounceMs);
  }
}

async function fetchSupabaseData(showNotification = false) {
  if (!state.supabaseClient) getSupabaseClient();
  if (!state.supabaseClient) return;
  try {
    const { data, error } = await state.supabaseClient
      .from('esp32_devices')
      .select('*')
      .eq('id', 1)
      .single();

    if (data && !error) {
      applyDeviceDataFromSupabase(data);
      if (showNotification) {
        showToast('อัปเดตข้อมูลจาก Supabase Cloud เรียบร้อย', 'info');
      }
    }
  } catch (err) {
    console.warn('Cloud fetch error:', err);
  }
}

function applyDeviceDataFromSupabase(dev) {
  // ส่งข้อมูลให้ระบบตั้งเวลา (schedule.js) อ่านคอลัมน์ schedule_text
  if (window.ScheduleUI) window.ScheduleUI.onCloudData(dev);
  // ส่งข้อมูลให้ระบบรอบเพาะเลี้ยง/เฟส PSB (phase.js) อ่านค่าสีและคอลัมน์ batch_*
  if (window.PhaseUI) window.PhaseUI.onCloudData(dev);
  // ตัวบอกสถานะบอร์ดออนไลน์/ออฟไลน์ (presence.js) จาก updated_at
  if (window.PresenceUI) window.PresenceUI.onCloudData(dev);

  const now = Date.now();

  // Relays sync with lockout guard
  let relaysChanged = false;
  [dev.relay1, dev.relay2, dev.relay3, dev.relay4].forEach((val, idx) => {
    if (now - lastUserRelayActionTime[idx] >= 1500) {
      const b = Boolean(val);
      if (state.relays[idx] !== b) {
        state.relays[idx] = b;
        relaysChanged = true;
      }
    }
  });
  if (relaysChanged) renderRelays();

  if (typeof dev.temperature === 'number') state.dht.temp = Number(dev.temperature);
  if (typeof dev.humidity === 'number') state.dht.hum = Number(dev.humidity);
  renderDHT();

  if (dev.color_r !== undefined && dev.color_r !== null) {
    state.color.r = Number(dev.color_r);
    state.color.g = Number(dev.color_g);
    state.color.b = Number(dev.color_b);
    state.color.c = dev.color_c || 1200;
    state.color.hex = dev.color_hex || rgbToHex(state.color.r, state.color.g, state.color.b);
    renderColorSensor();
  }

  // Sync Sensor White LED state
  if (now - lastUserLedActionTime >= 1500) {
    if (dev.name === 'led_off') {
      state.sensorLed = false;
    } else if (dev.name === 'led_on') {
      state.sensorLed = true;
    }
    if (elements.sensorLedToggle) {
      elements.sensorLedToggle.checked = state.sensorLed;
    }
    if (elements.sensorLedStatusText) {
      elements.sensorLedStatusText.textContent = state.sensorLed ? 'เปิด' : 'ปิด';
      elements.sensorLedStatusText.style.color = state.sensorLed ? '#3b82f6' : '#94a3b8';
    }
  }

  updateLastUpdatedTime();
}

// --- Relay Control (Handles Cloud, Local & Demo) ---
async function handleRelayToggle(channel, targetState) {
  const index = channel - 1;
  const previousState = state.relays[index];

  // Set Lockout Guard
  lastUserRelayActionTime[index] = Date.now();

  // Optimistic UI Update
  state.relays[index] = targetState;
  renderRelays();

  if (state.isDemoMode) {
    showToast(`Relay ${channel}: ${targetState ? 'เปิด (ON)' : 'ปิด (OFF)'}`, targetState ? 'success' : 'info', 1800);
    return;
  }

  // If in Supabase Cloud Mode
  if (state.connMode === 'supabase' && state.supabaseClient) {
    try {
      const fieldName = `relay${channel}`;
      const { error } = await state.supabaseClient
        .from('esp32_devices')
        .update({ [fieldName]: targetState, updated_at: new Date().toISOString() })
        .eq('id', 1);

      if (error) throw error;
      showToast(`[Cloud] Relay ${channel}: ${targetState ? 'เปิด (ON)' : 'ปิด (OFF)'}`, 'success');
    } catch (err) {
      console.error('Supabase update failed:', err);
      state.relays[index] = previousState;
      renderRelays();
      showToast(`อัปเดตสถานะ Relay ${channel} ไปยัง Cloud ไม่สำเร็จ`, 'error');
    }
    return;
  }

  // If in Local IP Mode
  try {
    const url = `http://${state.espIp}/toggle?ch=${channel}&state=${targetState ? 1 : 0}`;
    const signal = (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal)
      ? AbortSignal.timeout(2500)
      : null;

    const res = await fetch(url, { method: 'GET', signal });
    if (!res.ok) throw new Error('Switch request rejected');
    showToast(`Relay ${channel}: ${targetState ? 'เปิด (ON)' : 'ปิด (OFF)'}`, 'success');
  } catch (err) {
    state.relays[index] = previousState;
    renderRelays();
    showToast(`สั่งงาน Relay ${channel} ไม่สำเร็จ (ตรวจสอบบอร์ด)`, 'error');
  }
}

async function handleMasterAll(targetState) {
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    lastUserRelayActionTime[i] = now;
  }

  state.relays = [targetState, targetState, targetState, targetState];
  renderRelays();

  if (state.isDemoMode) {
    showToast(`สั่ง${targetState ? 'เปิด' : 'ปิด'}ทั้งหมด 4 ช่อง เรียบร้อย`, targetState ? 'success' : 'info', 1800);
    return;
  }

  // Cloud Mode
  if (state.connMode === 'supabase' && state.supabaseClient) {
    try {
      const { error } = await state.supabaseClient
        .from('esp32_devices')
        .update({
          relay1: targetState,
          relay2: targetState,
          relay3: targetState,
          relay4: targetState,
          updated_at: new Date().toISOString()
        })
        .eq('id', 1);

      if (error) throw error;
      showToast(`[Cloud] สั่ง${targetState ? 'เปิด' : 'ปิด'}รีเลย์ทั้งหมดเรียบร้อยแล้ว`, 'success');
    } catch (err) {
      showToast('สั่งงานผ่าน Cloud ไม่สำเร็จ', 'error');
    }
    return;
  }

  // Local Mode
  try {
    await fetch(`http://${state.espIp}/master?state=${targetState ? 1 : 0}`);
    showToast(`สั่ง${targetState ? 'เปิด' : 'ปิด'}รีเลย์ทั้งหมดเรียบร้อยแล้ว`, 'success');
  } catch (err) {
    showToast('สั่งงานไปยังบอร์ดไม่สำเร็จ', 'error');
  }
}

// --- Local IP Fetch Operations ---
async function fetchLocalData() {
  if (state.isDemoMode || state.isFetching) return;
  state.isFetching = true;
  updateConnectionBadge('fetching');

  const startTime = performance.now();
  try {
    const signal = (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal)
      ? AbortSignal.timeout(2500)
      : null;

    const res = await fetch(`http://${state.espIp}/api/data`, {
      method: 'GET',
      signal: signal,
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });

    const latency = Math.round(performance.now() - startTime);
    state.lastPingMs = latency;
    elements.pingValue.textContent = `${latency} ms`;

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    processLocalApiData(json);

    consecutiveFailures = 0;
    state.isConnected = true;
    updateConnectionBadge('connected');
    updateLastUpdatedTime();
  } catch (err) {
    consecutiveFailures++;
    state.isConnected = false;
    updateConnectionBadge('disconnected');
    elements.pingValue.textContent = 'Offline';
  } finally {
    state.isFetching = false;
  }
}

function processLocalApiData(data) {
  if (Array.isArray(data.relays)) {
    state.relays = data.relays.map(v => Boolean(v));
    renderRelays();
  }
  if (data.dht) {
    if (typeof data.dht.temp === 'number') state.dht.temp = data.dht.temp;
    if (typeof data.dht.hum === 'number') state.dht.hum = data.dht.hum;
    renderDHT();
  }
  if (data.color) {
    state.color.r = data.color.r ?? state.color.r;
    state.color.g = data.color.g ?? state.color.g;
    state.color.b = data.color.b ?? state.color.b;
    state.color.c = data.color.c ?? state.color.c;
    state.color.hex = data.color.hex || rgbToHex(state.color.r, state.color.g, state.color.b);
    renderColorSensor();
  }
}

// --- Render Functions (with Diffing to prevent UI stutter) ---
function renderRelays() {
  state.relays.forEach((isOn, idx) => {
    const card = elements.relayCards[idx];
    const sw = elements.relaySwitches[idx];
    const txt = elements.relayStatusTexts[idx];

    if (!card || !sw || !txt) return;

    // Only touch DOM if values actually differ
    if (sw.checked !== isOn) sw.checked = isOn;
    if (isOn) {
      if (!card.classList.contains('is-on')) card.classList.add('is-on');
      if (txt.textContent !== 'ON') txt.textContent = 'ON';
    } else {
      if (card.classList.contains('is-on')) card.classList.remove('is-on');
      if (txt.textContent !== 'OFF') txt.textContent = 'OFF';
    }
  });
}

function renderDHT() {
  const t = state.dht.temp;
  const h = state.dht.hum;

  elements.tempValue.textContent = t.toFixed(1);
  elements.humValue.textContent = h.toFixed(1);

  const tempPercent = Math.min(Math.max((t / 50) * 100, 0), 100);
  elements.tempBar.style.width = `${tempPercent}%`;

  if (t < 22) {
    elements.tempStatusBadge.textContent = 'เย็นสบาย (Cool)';
    elements.tempStatusBadge.className = 'sensor-status-badge badge-hum-normal';
  } else if (t <= 31) {
    elements.tempStatusBadge.textContent = 'สบายตัว (Comfort)';
    elements.tempStatusBadge.className = 'sensor-status-badge badge-temp-warm';
  } else {
    elements.tempStatusBadge.textContent = 'อากาศร้อน (Warm)';
    elements.tempStatusBadge.className = 'sensor-status-badge badge-danger';
  }

  const humPercent = Math.min(Math.max(h, 0), 100);
  elements.humBar.style.width = `${humPercent}%`;

  if (h < 40) elements.humStatusBadge.textContent = 'อากาศแห้ง (Dry)';
  else if (h <= 70) elements.humStatusBadge.textContent = 'เหมาะสม (Normal)';
  else elements.humStatusBadge.textContent = 'ความชื้นสูง (High)';
}

function renderColorSensor() {
  const { r, g, b, c, hex } = state.color;

  elements.colorPreviewBox.style.backgroundColor = hex;
  elements.colorPreviewBox.style.boxShadow = `0 12px 30px ${hex}55`;

  elements.previewHexBadge.textContent = hex.toUpperCase();
  elements.hexCodeDisplay.textContent = hex.toUpperCase();
  elements.btnHexLabel.textContent = hex.toUpperCase();

  elements.valRed.textContent = r;
  elements.barRed.style.width = `${(r / 255) * 100}%`;

  elements.valGreen.textContent = g;
  elements.barGreen.style.width = `${(g / 255) * 100}%`;

  elements.valBlue.textContent = b;
  elements.barBlue.style.width = `${(b / 255) * 100}%`;

  elements.valClear.textContent = c.toLocaleString();
  elements.barClear.style.width = `${Math.min((c / 3000) * 100, 100)}%`;

  elements.colorNameEstimate.textContent = estimateColorName(r, g, b);
}

// --- Helpers: Color Calculation ---
function rgbToHex(r, g, b) {
  const toHex = (n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function estimateColorName(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  if (max - min < 25) {
    if (max > 210) return 'สีขาว / White';
    if (max < 50) return 'สีดำ / Black';
    return 'สีเทา / Gray';
  }

  if (r > 180 && g < 90 && b < 90) return 'สีแดง / Red';
  if (r > 200 && g > 110 && b < 60) return 'สีส้ม / Orange';
  if (r > 190 && g > 190 && b < 100) return 'สีเหลือง / Yellow';
  if (g > 150 && r < 120 && b < 140) return 'สีเขียว / Green';
  if (b > 180 && r < 110 && g > 130) return 'สีฟ้า / Cyan';
  if (b > 170 && r < 130 && g < 130) return 'สีน้ำเงิน / Blue';
  if (r > 140 && b > 140 && g < 110) return 'สีม่วง / Purple';
  if (r > 200 && b > 140 && g < 130) return 'สีชมพู / Pink';

  return 'เฉดสีผสม / Mixed';
}

function copyHexToClipboard() {
  const hex = state.color.hex.toUpperCase();
  navigator.clipboard.writeText(hex).then(() => {
    vibrate(30);
    showToast(`คัดลอกรหัสสี ${hex} เรียบร้อยแล้ว`, 'success');
  }).catch(() => {
    showToast(`ไม่สามารถคัดลอกได้: ${hex}`, 'error');
  });
}

function randomizeColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  const c = Math.floor(Math.random() * 2000) + 400;

  state.color = { r, g, b, c, hex: rgbToHex(r, g, b) };
  renderColorSensor();
}

// --- Simulation Engine for Demo Mode ---
function simulateRandomFluctuation() {
  const tDelta = (Math.random() - 0.5) * 0.8;
  state.dht.temp = parseFloat(Math.min(Math.max(state.dht.temp + tDelta, 25.0), 34.0).toFixed(1));

  const hDelta = (Math.random() - 0.5) * 1.6;
  state.dht.hum = parseFloat(Math.min(Math.max(state.dht.hum + hDelta, 45.0), 85.0).toFixed(1));

  state.color.c = Math.max(200, state.color.c + Math.floor((Math.random() - 0.5) * 50));
}

function setupPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (state.isDemoMode) {
      simulateRandomFluctuation();
      renderDHT();
      updateLastUpdatedTime();
    } else {
      // Continuous background polling from Supabase Cloud (every 1s)
      // This ensures color & sensor data always updates automatically without manual refresh
      if (state.supabaseUrl && state.supabaseKey) {
        fetchSupabaseData(false);
      }
      if (state.connMode === 'local') {
        fetchLocalData();
      }
    }
  }, 1000);
}

// Helper to switch cleanly into Demo Mode
function enableDemoMode() {
  state.isDemoMode = true;
  elements.demoModeToggle.checked = true;
  localStorage.setItem('esp32_demo', 'true');
  consecutiveFailures = 0;
  state.isConnected = true;
  updateConnectionBadge('demo');
  setupPolling(); // Ensure polling interval is running
  simulateRandomFluctuation();
  renderDHT();
  renderColorSensor();
  updateLastUpdatedTime();

  try {
    console.clear();
    console.info('%c[ESP32 Smart Controller] โหมดจำลอง (Demo Mode) เปิดใช้งานเรียบร้อยแล้ว', 'color: #10b981; font-weight: bold;');
  } catch (e) {}
}

// --- UI Indicators & Timestamp ---
function updateConnectionBadge(overrideStatus) {
  const badge = elements.connectionStatusBadge;
  const text = elements.connectionStatusText;

  badge.className = 'status-pill';

  if (state.isDemoMode) {
    badge.classList.add('status-demo');
    text.textContent = 'โหมดจำลอง (Demo)';
    elements.pingValue.textContent = '0 ms (Local)';
    return;
  }

  const status = overrideStatus || (state.isConnected ? 'connected' : 'disconnected');

  if (status === 'cloud' || status === 'connected') {
    badge.classList.add('status-connected');
    if (state.connMode === 'supabase') {
      text.textContent = 'Online';
    } else {
      text.textContent = 'เชื่อมต่อ IP แล้ว';
    }
  } else if (status === 'loading' || status === 'fetching') {
    badge.classList.add('status-fetching');
    text.textContent = 'กำลังเชื่อมต่อ...';
  } else {
    badge.classList.add('status-disconnected');
    text.textContent = 'ไม่พบการเชื่อมต่อ';
  }
}

function updateLastUpdatedTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('th-TH', { hour12: false });
  elements.lastUpdated.textContent = `เวลา: ${timeStr}`;
}

// --- Theme Management ---
function applyTheme(theme) {
  state.theme = theme;
  elements.html.setAttribute('data-theme', theme);
  localStorage.setItem('esp32_theme', theme);
}

// --- Haptic Feedback Helper ---
function vibrate(pattern) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}

// --- Toast Notifications ---
function showToast(message, type = 'info', duration = 2500, onClick = null) {
  // Cap at 3 toasts max to prevent UI lag/flooding
  while (elements.toastContainer.children.length >= 3) {
    elements.toastContainer.removeChild(elements.toastContainer.firstChild);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  if (typeof onClick === 'function') {
    toast.style.cursor = 'pointer';
    toast.title = 'คลิกเพื่อดำเนินการ';
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, duration);
}

// ===================================================================
// Wi-Fi Config Modal & Web Serial API Manager
// ===================================================================
let serialPort = null;
let serialReader = null;
let serialWriter = null;
let serialReadableStreamClosed = null;
let serialWritableStreamClosed = null;

function initWebSerialManager() {
  const modal = document.getElementById('wifiModal');
  const openBtn = document.getElementById('openWifiModalBtn');
  const closeBtn = document.getElementById('closeWifiModalBtn');
  const tabSerial = document.getElementById('modalTabSerial');
  const tabHotspot = document.getElementById('modalTabHotspot');
  const panelSerial = document.getElementById('modalPanelSerial');
  const panelHotspot = document.getElementById('modalPanelHotspot');

  const connectSerialBtn = document.getElementById('connectSerialBtn');
  const connectSerialBtnText = document.getElementById('connectSerialBtnText');
  const serialStatusDot = document.getElementById('serialStatusDot');
  const serialStatusText = document.getElementById('serialStatusText');
  const serialControlsWrap = document.getElementById('serialControlsWrap');
  const scanWifiBtn = document.getElementById('scanWifiBtn');
  const serialSsidSelect = document.getElementById('serialSsidSelect');
  const serialWifiPass = document.getElementById('serialWifiPass');
  const sendWifiBtn = document.getElementById('sendWifiBtn');
  const serialLog = document.getElementById('serialLog');
  const clearTerminalBtn = document.getElementById('clearTerminalBtn');

  if (!modal || !openBtn) return;

  function appendLog(msg, color = '') {
    if (!serialLog) return;
    const time = new Date().toLocaleTimeString('th-TH', { hour12: false });
    serialLog.textContent += `\n[${time}] ${msg}`;
    serialLog.scrollTop = serialLog.scrollHeight;
  }

  // Open / Close Modal
  openBtn.addEventListener('click', () => {
    vibrate(30);
    modal.style.display = 'flex';
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      vibrate(20);
      modal.style.display = 'none';
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });

  // Switch Modal Tabs
  if (tabSerial && tabHotspot) {
    tabSerial.addEventListener('click', () => {
      vibrate(20);
      tabSerial.classList.add('active');
      tabHotspot.classList.remove('active');
      panelSerial.style.display = 'block';
      panelHotspot.style.display = 'none';
    });

    tabHotspot.addEventListener('click', () => {
      vibrate(20);
      tabHotspot.classList.add('active');
      tabSerial.classList.remove('active');
      panelHotspot.style.display = 'block';
      panelSerial.style.display = 'none';
    });
  }

  // Clear Terminal
  if (clearTerminalBtn) {
    clearTerminalBtn.addEventListener('click', () => {
      if (serialLog) serialLog.textContent = 'ล้างหน้าจอแล้ว...';
    });
  }

  // Check Web Serial support
  const isSerialSupported = 'serial' in navigator;
  if (!isSerialSupported && connectSerialBtn) {
    connectSerialBtn.classList.remove('btn-primary');
    connectSerialBtn.classList.add('btn-secondary');
    if (connectSerialBtnText) {
      connectSerialBtnText.textContent = 'Web Serial ใช้งานได้บน Chrome / Edge';
    }
    appendLog('เบราว์เซอร์นี้ไม่รองรับ Web Serial API แนะนำเปิดบน Google Chrome / Microsoft Edge บนคอมพิวเตอร์ หรือใช้วิธี Smart Hotspot ผ่านมือถือ');
  }

  // Connect Serial Button
  if (connectSerialBtn && isSerialSupported) {
    connectSerialBtn.addEventListener('click', async () => {
      vibrate(30);

      if (serialPort) {
        // Disconnect
        await disconnectSerial();
        return;
      }

      try {
        appendLog('กำลังเปิดหน้าต่างเลือกพอร์ต USB...');
        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: 115200 });

        // Update UI
        if (serialStatusDot) serialStatusDot.style.background = '#34c759';
        if (serialStatusText) serialStatusText.textContent = 'เชื่อมต่อพอร์ต Serial สำเร็จ (115200 baud)';
        if (connectSerialBtnText) connectSerialBtnText.textContent = 'ตัดการเชื่อมต่อ USB';
        connectSerialBtn.classList.remove('btn-primary');
        connectSerialBtn.classList.add('btn-secondary');
        if (serialControlsWrap) {
          serialControlsWrap.style.opacity = '1';
          serialControlsWrap.style.pointerEvents = 'auto';
        }

        appendLog('✅ เชื่อมต่อ USB Serial พอร์ตสำเร็จเรียบร้อย!');
        showToast('✅ เชื่อมต่อพอร์ต USB สำเร็จแล้ว!', 'success');

        // Setup Streams
        const textDecoder = new TextDecoderStream();
        serialReadableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
        serialReader = textDecoder.readable.getReader();

        const textEncoder = new TextEncoderStream();
        serialWritableStreamClosed = textEncoder.readable.pipeTo(serialPort.writable);
        serialWriter = textEncoder.writable.getWriter();

        // Read Loop
        readSerialLoop();

        // Auto request device info
        setTimeout(() => {
          sendSerialCommand('CMD:GET_INFO');
        }, 500);

      } catch (err) {
        console.error('Serial connection error:', err);
        appendLog(`⚠️ ข้อผิดพลาด: ${err.message}`);
        showToast(`เชื่อมต่อไม่สำเร็จ: ${err.message}`, 'error');
      }
    });
  }

  async function disconnectSerial() {
    try {
      if (serialReader) {
        await serialReader.cancel();
        await serialReadableStreamClosed.catch(() => {});
        serialReader = null;
      }
      if (serialWriter) {
        await serialWriter.close();
        await serialWritableStreamClosed;
        serialWriter = null;
      }
      if (serialPort) {
        await serialPort.close();
        serialPort = null;
      }

      if (serialStatusDot) serialStatusDot.style.background = '#8e8e93';
      if (serialStatusText) serialStatusText.textContent = 'สถานะ: ยังไม่ได้เชื่อมต่อสาย USB';
      if (connectSerialBtnText) connectSerialBtnText.textContent = 'เชื่อมต่อพอร์ต USB (COM Port)';
      if (connectSerialBtn) {
        connectSerialBtn.classList.remove('btn-secondary');
        connectSerialBtn.classList.add('btn-primary');
      }
      if (serialControlsWrap) {
        serialControlsWrap.style.opacity = '0.5';
        serialControlsWrap.style.pointerEvents = 'none';
      }

      appendLog('🛑 ตัดการเชื่อมต่อพอร์ต USB แล้ว');
      showToast('ตัดการเชื่อมต่อ USB แล้ว', 'info');
    } catch (e) {
      console.warn('Error disconnecting serial:', e);
    }
  }

  async function sendSerialCommand(cmd) {
    if (!serialWriter) {
      showToast('กรุณาเชื่อมต่อสาย USB ก่อน', 'error');
      return;
    }
    try {
      appendLog(`>>> ส่งคำสั่ง: ${cmd}`);
      await serialWriter.write(cmd + '\n');
    } catch (e) {
      appendLog(`⚠️ ไม่สามารถส่งคำสั่งได้: ${e.message}`);
    }
  }

  async function readSerialLoop() {
    let buffer = '';
    try {
      while (serialReader) {
        const { value, done } = await serialReader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep unfinished line
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line) processIncomingSerialLine(line);
          }
        }
      }
    } catch (e) {
      console.warn('Serial read loop stopped:', e);
    }
  }

  function processIncomingSerialLine(line) {
    appendLog(line);

    // Try parse JSON events from ESP32
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const data = JSON.parse(line);
        if (data.event === 'scan_result' && Array.isArray(data.networks)) {
          if (serialSsidSelect) {
            serialSsidSelect.innerHTML = '';
            if (data.networks.length === 0) {
              serialSsidSelect.innerHTML = '<option value="">-- ไม่พบ Wi-Fi 2.4GHz --</option>';
            } else {
              data.networks.forEach(net => {
                const opt = document.createElement('option');
                opt.value = net;
                opt.textContent = `📶 ${net}`;
                serialSsidSelect.appendChild(opt);
              });
            }
          }
          showToast(`🔍 พบ Wi-Fi ทั้งหมด ${data.networks.length} เครือข่าย`, 'success');
        } else if (data.event === 'wifi_status') {
          if (data.status === 'connecting') {
            showToast(`บอร์ดกำลังเชื่อมต่อ Wi-Fi: ${data.ssid}...`, 'info');
          } else if (data.status === 'connected') {
            showToast(`🎉 ESP32 เชื่อมต่อ Wi-Fi สำเร็จ! IP: ${data.ip}`, 'success', 6000);
            state.espIp = data.ip;
            localStorage.setItem('esp32_ip', data.ip);
            if (elements.espIpInput) elements.espIpInput.value = data.ip;
            appendLog(`🎉 [สำเร็จ] อัปเดต IP: ${data.ip} เข้า Dashboard เรียบร้อยแล้ว!`);
          } else if (data.status === 'failed') {
            showToast('⚠️ เชื่อมต่อ Wi-Fi ไม่สำเร็จ กรุณาเช็ครหัสผ่าน', 'error', 5000);
          }
        } else if (data.event === 'device_info') {
          appendLog(`ℹ️ [สถานะปัจจุบัน] Wi-Fi: ${data.ssid || '-'} | IP: ${data.ip || '-'}`);
        }
      } catch (e) {}
    }
  }

  // Scan Wi-Fi Button
  if (scanWifiBtn) {
    scanWifiBtn.addEventListener('click', () => {
      vibrate(25);
      sendSerialCommand('CMD:SCAN_WIFI');
      showToast('กำลังสั่งให้ ESP32 สแกนหา Wi-Fi รอบตัว...', 'info');
    });
  }

  // Send Wi-Fi Config Button
  if (sendWifiBtn) {
    sendWifiBtn.addEventListener('click', () => {
      const ssid = serialSsidSelect ? serialSsidSelect.value.trim() : '';
      const pass = serialWifiPass ? serialWifiPass.value.trim() : '';

      if (!ssid) {
        showToast('กรุณาเลือกชื่อ Wi-Fi ก่อน', 'error');
        return;
      }

      vibrate(35);
      appendLog(`ส่งข้อมูลบันทึก Wi-Fi -> SSID: ${ssid}`);
      sendSerialCommand(`CMD:SET_WIFI:${ssid}:${pass}`);
      showToast(`ส่งข้อมูล Wi-Fi ให้ ESP32 แล้ว กำลังเชื่อมต่อ...`, 'info', 4000);
    });
  }
}

// ===================================================================
// Firmware Flasher & Wiring Modal Manager
// ===================================================================
function initFlasherModalManager() {
  const modal = document.getElementById('flasherModal');
  const openBtn = document.getElementById('openFlasherModalBtn');
  const closeBtn = document.getElementById('closeFlasherModalBtn');

  const tabWiring = document.getElementById('flasherTabWiring');
  const tabInstall = document.getElementById('flasherTabInstall');
  const tabCode = document.getElementById('flasherTabCode');

  const panelWiring = document.getElementById('flasherPanelWiring');
  const panelInstall = document.getElementById('flasherPanelInstall');
  const panelCode = document.getElementById('flasherPanelCode');

  const copyInoBtn = document.getElementById('copyInoBtn');
  const inoCodePreview = document.getElementById('inoCodePreview');

  if (!modal || !openBtn) return;

  openBtn.addEventListener('click', () => {
    vibrate(30);
    modal.style.display = 'flex';
    loadInoCode();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      vibrate(20);
      modal.style.display = 'none';
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  function switchTab(activeTab, activePanel) {
    vibrate(20);
    [tabWiring, tabInstall, tabCode].forEach(t => t && t.classList.remove('active'));
    [panelWiring, panelInstall, panelCode].forEach(p => p && (p.style.display = 'none'));
    if (activeTab) activeTab.classList.add('active');
    if (activePanel) activePanel.style.display = 'block';
  }

  if (tabWiring) tabWiring.addEventListener('click', () => switchTab(tabWiring, panelWiring));
  if (tabInstall) tabInstall.addEventListener('click', () => switchTab(tabInstall, panelInstall));
  if (tabCode) tabCode.addEventListener('click', () => {
    switchTab(tabCode, panelCode);
    loadInoCode();
  });

  let loadedInoCode = '';
  async function loadInoCode() {
    if (loadedInoCode) return;
    try {
      const res = await fetch('esp32_supabase.ino');
      if (res.ok) {
        loadedInoCode = await res.text();
        if (inoCodePreview) inoCodePreview.textContent = loadedInoCode;
      }
    } catch (e) {
      if (inoCodePreview) inoCodePreview.textContent = '// ไม่สามารถโหลดไฟล์โค้ดอัตโนมัติได้ สามารถเปิดไฟล์ esp32_supabase.ino ในโปรเจกต์ได้โดยตรง';
    }
  }

  if (copyInoBtn) {
    copyInoBtn.addEventListener('click', async () => {
      vibrate(30);
      if (!loadedInoCode) await loadInoCode();
      if (loadedInoCode && navigator.clipboard) {
        await navigator.clipboard.writeText(loadedInoCode);
        showToast('📋 คัดลอกโค้ด C++ (esp32_supabase.ino) เรียบร้อยแล้ว!', 'success');
      } else {
        showToast('กรุณาคัดลอกจากหน้าต่างด้านล่าง', 'info');
      }
    });
  }
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  initWebSerialManager();
  initFlasherModalManager();
});

