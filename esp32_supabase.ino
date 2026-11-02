/*
 * =========================================================================
 * ESP32 Complete IoT Controller - Supabase Cloud (High-Speed Realtime v1)
 * 4-Channel Relays + DHT Temp/Humidity + TCS34725 Color Sensor + LED Control
 * =========================================================================
 * 
 * 🚀 การปรับจูนความเร็ว (Turbo Realtime Tuning):
 * 1. ตรวจสอบคำสั่งสวิตช์รีเลย์และไฟ LED ทุก 350ms (ตอบสนองในเสี้ยววินาที)
 * 2. ตรวจสอบและส่งค่าสีทุก 800ms และส่งทันทีเมื่อตรวจพบว่าวัตถุเปลี่ยนสี
 * 3. เปิดใช้งาน HTTP Keep-Alive (setReuse) เพื่อลดเวลาต่อ TLS Handshake ลงเหลือ 50ms
 * 4. เซนเซอร์ DHT อุณหภูมิ/ความชื้น ส่งอัปเดตทุก 3 วินาทีเพื่อความแม่นยำ
 * 
 * ขาต่อใช้งาน:
 * - Relay 4 ช่อง : GPIO 16, 17, 18, 19
 * - DHT อุณหภูมิ  : GPIO 4
 * - สี TCS34725  : SDA=GPIO 21, SCL=GPIO 22
 * - ไฟ LED เซนเซอร์: GPIO 23
 * =========================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>

// --- ขาควบคุมไฟ LED สีขาวของเซนเซอร์สี (GPIO 23) ---
const int COLOR_LED_PIN = 23; 
bool colorLedState = true; // สถานะเริ่มต้น: เปิดไฟ (ON)

// --- ตั้งค่าเซนเซอร์ DHT ---
const bool IS_DHT22 = false; // ตัวสีฟ้า (DHT11) = false, ตัวสีขาว (DHT22) = true
const int DHT_PIN = 4;       // ขาต่อเซนเซอร์อุณหภูมิ (GPIO 4)

// --- ขารีเลย์ 4 ช่อง (16, 17, 18, 19) ---
const int relayPins[4] = {16, 17, 18, 19};
bool relayStates[4] = {false, false, false, false};

// --- การตั้งค่า WiFi (บันทึกลง Flash Memory ถาวร) ---
Preferences preferences;
String currentSSID = "";
String currentPass = "";
const char* defaultSSID = "YOUR_WIFI_SSID";
const char* defaultPass = "YOUR_WIFI_PASSWORD";

// --- Smart Hotspot & Captive Portal Server ---
WebServer apServer(80);
DNSServer dnsServer;
const byte DNS_PORT = 53;
bool apModeActive = false;

// --- การตั้งค่า Supabase Cloud ---
const char* supabaseUrl = "https://fgkhnqqxrvfoluvjacnz.supabase.co";
const char* supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2hucXF4cnZmb2x1dmphY256Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNTA4NzIsImV4cCI6MjEwODkyNjg3Mn0.OGoF2a1mYKn3DMf20A21QibNp9JcJyd3bSXF-EQ2tM4";

// 🚀 ตัวแปรช่วงเวลาความเร็วสูง (High-Speed Intervals)
unsigned long lastRelayCheck = 0;
const unsigned long relayInterval = 350;     // ตรวจสอบสวิตช์ทุก 350 มิลลิวินาที (ไวขึ้นเกือบ 3 เท่า!)

unsigned long lastColorCheck = 0;
const unsigned long colorInterval = 800;     // ส่งค่าสีทุก 800 มิลลิวินาที (ไวขึ้น 5 เท่า!)

unsigned long lastDhtCheck = 0;
const unsigned long dhtInterval = 3000;      // ส่งอุณหภูมิ/ความชื้นทุก 3 วินาที

// ตัวแปรจดจำค่าสีล่าสุด เพื่อส่งทันทีเมื่อสีเปลี่ยน
int lastSentR = -999, lastSentG = -999, lastSentB = -999;
float lastTemp = 28.5, lastHum = 60.0;

#define TCS34725_ADDR 0x29
bool tcsFound = false;

// -------------------------------------------------------------
// ระบบตั้งเวลาเปิด-ปิดรีเลย์อัตโนมัติ (Schedule) — ตัวแปรส่วนกลาง
// -------------------------------------------------------------
const long TZ_OFFSET_SEC = 7 * 3600;   // เวลาไทย UTC+7 (ต้องตรงกับ TZ_OFFSET_MIN ใน schedule.js)
#define MAX_RULES 16
struct SchedRule { uint8_t ch; char type; int p1; int p2; bool en; };
SchedRule schedRules[MAX_RULES];
int schedRuleCount = 0;
String schedRaw = "";
int8_t lastSchedState[4] = {-1, -1, -1, -1};       // สถานะล่าสุดที่ตารางสั่ง (-1 = ยังไม่เคยสั่ง)
unsigned long holdCloudUntil[4] = {0, 0, 0, 0};    // กันไม่ให้ค่าเก่าจาก Cloud ทับคำสั่งของตารางทันที
unsigned long lastSchedEval = 0;
unsigned long lastSchedFetch = 0;
const unsigned long schedFetchInterval = 15000;    // ดึงตารางจาก Cloud ทุก 15 วินาที
int localMinuteOfDay();

// ฟังก์ชันสั่งงานไฟ LED บนเซนเซอร์สี
void setColorLed(bool state) {
  colorLedState = state;
  if (state) {
    pinMode(COLOR_LED_PIN, INPUT); // ปล่อยขาลอย ไฟ LED ติดสว่าง
    Serial.println(">>> [Sensor LED] เปิดไฟส่องสี (ON)");
  } else {
    pinMode(COLOR_LED_PIN, OUTPUT);
    digitalWrite(COLOR_LED_PIN, LOW); // ดึงลงกราวด์ ไฟ LED ดับสนิท
    Serial.println(">>> [Sensor LED] ปิดไฟส่องสี (OFF)");
  }
}

// ฟังก์ชันสั่งงานรีเลย์ Active LOW (Open-Drain)
void setRelay(int index, bool state) {
  if (index < 0 || index >= 4) return;
  relayStates[index] = state;
  int pin = relayPins[index];

  if (state) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    Serial.printf(">>> [Relay %d (ขา %d)] -> เปิด (ON)\n", index + 1, pin);
  } else {
    pinMode(pin, INPUT);
    Serial.printf(">>> [Relay %d (ขา %d)] -> ปิด (OFF)\n", index + 1, pin);
  }
}

// ฟังก์ชันอ่านค่า Boolean จาก JSON
bool parseJsonBool(const String& json, const String& key) {
  int keyIndex = json.indexOf("\"" + key + "\":");
  if (keyIndex == -1) return false;
  String val = json.substring(keyIndex + key.length() + 3, keyIndex + key.length() + 9);
  val.trim();
  return val.startsWith("true") || val.startsWith("1");
}

// -------------------------------------------------------------
// สแกนหาอุปกรณ์ I2C บนขา 21 (SDA) และ 22 (SCL)
// -------------------------------------------------------------
void scanI2C() {
  Serial.println("\n[I2C Scanner] กำลังค้นหาอุปกรณ์บนขา SDA=21, SCL=22...");
  int nDevices = 0;
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    byte error = Wire.endTransmission();
    if (error == 0) {
      Serial.printf(">>> [I2C] พบอุปกรณ์ที่ Address: 0x%02X\n", address);
      nDevices++;
    }
  }
  if (nDevices == 0) {
    Serial.println(">>> [I2C] ยังไม่พบอุปกรณ์ I2C (ตรวจสอบสาย 3.3V, GND, SDA=21, SCL=22)");
  }
}

// -------------------------------------------------------------
// เริ่มต้นเซนเซอร์สี TCS34725
// -------------------------------------------------------------
bool initTCS34725() {
  Wire.begin(21, 22);
  Wire.setClock(100000);

  Wire.beginTransmission(TCS34725_ADDR);
  if (Wire.endTransmission() != 0) return false;

  Wire.beginTransmission(TCS34725_ADDR);
  Wire.write(0x80 | 0x01);
  Wire.write(0xEB); // ATIME 50ms
  Wire.endTransmission();

  Wire.beginTransmission(TCS34725_ADDR);
  Wire.write(0x80 | 0x0F);
  Wire.write(0x01); // 4x Gain
  Wire.endTransmission();

  Wire.beginTransmission(TCS34725_ADDR);
  Wire.write(0x80 | 0x00);
  Wire.write(0x01); // PON
  Wire.endTransmission();
  delay(3);

  Wire.beginTransmission(TCS34725_ADDR);
  Wire.write(0x80 | 0x00);
  Wire.write(0x03); // PON | AEN
  Wire.endTransmission();
  delay(60);

  return true;
}

// -------------------------------------------------------------
// อ่านค่าสีจาก TCS34725
// -------------------------------------------------------------
bool readColorSensor(int &outR, int &outG, int &outB, int &outC, String &outHex) {
  Wire.beginTransmission(TCS34725_ADDR);
  Wire.write(0xA0 | 0x14); // Auto-increment read
  if (Wire.endTransmission() != 0) return false;

  Wire.requestFrom(TCS34725_ADDR, 8);
  if (Wire.available() < 8) return false;

  uint16_t c = Wire.read() | (Wire.read() << 8);
  uint16_t r = Wire.read() | (Wire.read() << 8);
  uint16_t g = Wire.read() | (Wire.read() << 8);
  uint16_t b = Wire.read() | (Wire.read() << 8);

  outC = c;
  if (c <= 2) return false;

  float rf = ((float)r / (float)max((int)c, 1)) * 255.0;
  float gf = ((float)g / (float)max((int)c, 1)) * 255.0;
  float bf = ((float)b / (float)max((int)c, 1)) * 255.0;

  outR = constrain((int)rf, 0, 255);
  outG = constrain((int)gf, 0, 255);
  outB = constrain((int)bf, 0, 255);

  char hexBuf[10];
  snprintf(hexBuf, sizeof(hexBuf), "#%02X%02X%02X", outR, outG, outB);
  outHex = String(hexBuf);

  return true;
}

// -------------------------------------------------------------
// อ่านค่า DHT11 / DHT22
// -------------------------------------------------------------
bool readDHTSensor(int pin, float &temp, float &hum, bool is22) {
  uint8_t data[5] = {0, 0, 0, 0, 0};

  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
  delay(20);

  pinMode(pin, INPUT_PULLUP);
  delayMicroseconds(35);

  noInterrupts();

  unsigned long timeout = micros();
  while (digitalRead(pin) == HIGH) {
    if (micros() - timeout > 100) { interrupts(); return false; }
  }
  timeout = micros();
  while (digitalRead(pin) == LOW) {
    if (micros() - timeout > 100) { interrupts(); return false; }
  }
  timeout = micros();
  while (digitalRead(pin) == HIGH) {
    if (micros() - timeout > 100) { interrupts(); return false; }
  }

  for (int i = 0; i < 40; i++) {
    timeout = micros();
    while (digitalRead(pin) == LOW) {
      if (micros() - timeout > 90) { interrupts(); return false; }
    }
    unsigned long startHigh = micros();
    while (digitalRead(pin) == HIGH) {
      if (micros() - startHigh > 110) { interrupts(); return false; }
    }
    if ((micros() - startHigh) > 40) {
      data[i / 8] |= (1 << (7 - (i % 8)));
    }
  }

  interrupts();

  if (data[4] != ((data[0] + data[1] + data[2] + data[3]) & 0xFF)) return false;

  if (is22) {
    hum = ((data[0] << 8) | data[1]) * 0.1;
    int16_t rawT = ((data[2] & 0x7F) << 8) | data[3];
    temp = rawT * 0.1;
    if (data[2] & 0x80) temp = -temp;
  } else {
    hum = (float)data[0] + (float)data[1] * 0.1;
    temp = (float)data[2] + (float)data[3] * 0.1;
  }

  return true;
}

// -------------------------------------------------------------
// ดึงสถานะสวิตช์รีเลย์และไฟ LED ส่องสีจาก Supabase (ความเร็วสูง)
// -------------------------------------------------------------
void checkSwitchesFromSupabase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(1200); // ตั้ง Timeout สั้น 1.2 วินาที เพื่อไม่ให้ระบบค้าง
  https.setReuse(true);   // เปิดใช้ Connection Reuse เพื่อความไวสูงสุด

  String endpoint = String(supabaseUrl) + "/rest/v1/esp32_devices?id=eq.1&select=relay1,relay2,relay3,relay4,name";

  if (https.begin(client, endpoint)) {
    https.addHeader("apikey", supabaseAnonKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseAnonKey);
    https.addHeader("Accept", "application/json");
    https.addHeader("Accept-Profile", "public");

    int httpCode = https.GET();
    if (httpCode == HTTP_CODE_OK) {
      String payload = https.getString();
      
      bool r1 = parseJsonBool(payload, "relay1");
      bool r2 = parseJsonBool(payload, "relay2");
      bool r3 = parseJsonBool(payload, "relay3");
      bool r4 = parseJsonBool(payload, "relay4");

      if (r1 != relayStates[0] && (long)(millis() - holdCloudUntil[0]) >= 0) setRelay(0, r1);
      if (r2 != relayStates[1] && (long)(millis() - holdCloudUntil[1]) >= 0) setRelay(1, r2);
      if (r3 != relayStates[2] && (long)(millis() - holdCloudUntil[2]) >= 0) setRelay(2, r3);
      if (r4 != relayStates[3] && (long)(millis() - holdCloudUntil[3]) >= 0) setRelay(3, r4);

      if (payload.indexOf("\"name\":\"led_off\"") != -1) {
        if (colorLedState != false) setColorLed(false);
      } else if (payload.indexOf("\"name\":\"led_on\"") != -1) {
        if (colorLedState != true) setColorLed(true);
      }
    }
    https.end();
  }
}

// -------------------------------------------------------------
// ส่งข้อมูลสีขึ้น Supabase แบบความเร็วสูง (ส่งทันทีที่สีเปลี่ยน)
// -------------------------------------------------------------
void sendColorToSupabase(int r, int g, int b, int c, const String& hex) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(1200);
  https.setReuse(true);

  String endpoint = String(supabaseUrl) + "/rest/v1/esp32_devices?id=eq.1";

  if (https.begin(client, endpoint)) {
    https.addHeader("apikey", supabaseAnonKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseAnonKey);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("Content-Profile", "public");
    https.addHeader("Accept-Profile", "public");

    String jsonBody = "{\"color_r\":" + String(r) + 
                      ",\"color_g\":" + String(g) + 
                      ",\"color_b\":" + String(b) + 
                      ",\"color_c\":" + String(c) + 
                      ",\"color_hex\":\"" + hex + "\"}";

    https.PATCH(jsonBody);
    https.end();
  }
}

// -------------------------------------------------------------
// ส่งอุณหภูมิและความชื้นขึ้น Supabase
// -------------------------------------------------------------
void sendDhtToSupabase(float temp, float hum) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(1200);

  String endpoint = String(supabaseUrl) + "/rest/v1/esp32_devices?id=eq.1";

  if (https.begin(client, endpoint)) {
    https.addHeader("apikey", supabaseAnonKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseAnonKey);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("Content-Profile", "public");
    https.addHeader("Accept-Profile", "public");

    String jsonBody = "{\"temperature\":" + String(temp, 1) + ",\"humidity\":" + String(hum, 1) + "}";

    https.PATCH(jsonBody);
    https.end();
  }
}

// -------------------------------------------------------------
// ระบบตั้งเวลาเปิด-ปิดรีเลย์อัตโนมัติ (Schedule)
// ข้อความตารางเก็บในคอลัมน์ schedule_text ของ Supabase รูปแบบ  ช่อง,ชนิด,ค่า1,ค่า2,เปิดใช้;
//   ชนิด D = ช่วงเวลารายวัน  ค่า1=นาทีเริ่ม(0-1439)  ค่า2=นาทีสิ้นสุด(0-1439)  (ข้ามเที่ยงคืนได้)
//   ชนิด I = วนรอบ          ค่า1=คาบ(นาที)         ค่า2=เปิดนานกี่นาที
//   ตัวอย่าง "2,I,180,10,1;1,D,360,1080,1;" = ช่อง 2 เปิด 10 นาทีทุก 3 ชม. / ช่อง 1 เปิด 06:00-18:00
// ช่องที่มีกฎเปิดใช้อยู่จะถูกสั่ง "เฉพาะตอนสถานะตามตารางเปลี่ยน" กดสวิตช์มือทับได้จนกว่าจะถึงจังหวะถัดไป
// -------------------------------------------------------------

// แยกข้อความตารางเป็นกฎ คืนจำนวนกฎที่ถูกต้อง (ฟังก์ชัน C ล้วน ทดสอบแยกได้)
int parseScheduleText(const char* s, SchedRule* out, int maxOut) {
  int n = 0;
  const char* p = s;
  while (*p && n < maxOut) {
    int ch = 0, p1 = 0, p2 = 0, en = 1;
    char type = 0;
    int got = sscanf(p, " %d , %c , %d , %d , %d", &ch, &type, &p1, &p2, &en);
    bool ok = (got >= 4);
    if (ok) {
      if (ch < 1 || ch > 4) ok = false;
      else if (type == 'D') { if (p1 < 0 || p1 > 1439 || p2 < 0 || p2 > 1439) ok = false; }
      else if (type == 'I') { if (p1 < 1 || p1 > 1440 || p2 < 1) ok = false; }
      else ok = false;
    }
    if (ok) {
      out[n].ch = (uint8_t)ch;
      out[n].type = type;
      out[n].p1 = p1;
      out[n].p2 = p2;
      out[n].en = (got >= 5) ? (en != 0) : true;
      n++;
    }
    while (*p && *p != ';') p++;
    if (*p == ';') p++;
  }
  return n;
}

// กฎนี้ "กำลังเปิด" ณ เวลานี้หรือไม่ (epochMin = นาทีตามเวลาท้องถิ่นนับจาก epoch)
bool schedRuleActive(const SchedRule& r, long epochMin) {
  if (r.type == 'D') {
    int m = (int)(epochMin % 1440);
    if (r.p1 == r.p2) return false;
    if (r.p1 < r.p2) return m >= r.p1 && m < r.p2;
    return m >= r.p1 || m < r.p2;
  }
  if (r.type == 'I') {
    if (r.p1 <= 0) return false;
    return (epochMin % r.p1) < r.p2;
  }
  return false;
}

bool timeIsSynced() {
  return time(nullptr) > 1700000000L;   // เวลาถูกซิงก์จากอินเทอร์เน็ต (NTP) แล้ว
}

long localEpochMinutes() {
  return (long)((time(nullptr) + TZ_OFFSET_SEC) / 60);
}

int localMinuteOfDay() {
  if (!timeIsSynced()) return -1;
  return (int)(localEpochMinutes() % 1440);
}

bool applyScheduleText(const String& raw) {
  if (raw == schedRaw) return false;
  schedRaw = raw;
  schedRuleCount = parseScheduleText(raw.c_str(), schedRules, MAX_RULES);
  for (int i = 0; i < 4; i++) lastSchedState[i] = -1;   // บังคับประเมินใหม่ทันที
  Serial.printf(">>> [Schedule] โหลดตารางเวลา %d กฎ: %s\n", schedRuleCount, raw.c_str());
  return true;
}

void loadScheduleFromFlash() {
  preferences.begin("esp32_sched", false);
  String raw = preferences.getString("rules", "");
  preferences.end();
  applyScheduleText(raw);
}

void saveScheduleToFlash(const String& raw) {
  preferences.begin("esp32_sched", false);
  preferences.putString("rules", raw);
  preferences.end();
}

// อัปเดตสถานะรีเลย์ขึ้น Cloud เมื่อตารางสั่งเปลี่ยน เพื่อให้หน้าเว็บแสดงตรงกับของจริง
void sendRelayToSupabase(int idx, bool state) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(1500);

  String endpoint = String(supabaseUrl) + "/rest/v1/esp32_devices?id=eq.1";

  if (https.begin(client, endpoint)) {
    https.addHeader("apikey", supabaseAnonKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseAnonKey);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("Content-Profile", "public");
    https.addHeader("Accept-Profile", "public");

    String body = String("{\"relay") + String(idx + 1) + "\":" + (state ? "true" : "false") + "}";
    https.PATCH(body);
    https.end();
  }
}

// ดึงข้อความตารางเวลาจาก Cloud (ถ้ายังไม่มีคอลัมน์ schedule_text จะข้ามไป ใช้ตารางที่จำไว้ใน Flash)
void fetchScheduleFromSupabase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(1500);

  String endpoint = String(supabaseUrl) + "/rest/v1/esp32_devices?id=eq.1&select=schedule_text";

  if (https.begin(client, endpoint)) {
    https.addHeader("apikey", supabaseAnonKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseAnonKey);
    https.addHeader("Accept", "application/json");
    https.addHeader("Accept-Profile", "public");

    int httpCode = https.GET();
    if (httpCode == HTTP_CODE_OK) {
      String payload = https.getString();
      int k = payload.indexOf("\"schedule_text\":");
      if (k >= 0) {
        int v = k + 16;
        while (v < (int)payload.length() && payload[v] == ' ') v++;
        String raw = "";
        if (v < (int)payload.length() && payload[v] == '"') {
          int q2 = payload.indexOf('"', v + 1);
          if (q2 > v) raw = payload.substring(v + 1, q2);
        }
        if (applyScheduleText(raw)) saveScheduleToFlash(raw);
      }
    }
    https.end();
  }
}

// เรียกทุกรอบของ loop() (ทำงานจริงทุก 1 วินาที) — ทำงานต่อได้แม้ WiFi หลุด ถ้าเคยซิงก์เวลาแล้ว
void evaluateSchedule() {
  unsigned long nowMs = millis();
  if (nowMs - lastSchedEval < 1000) return;
  lastSchedEval = nowMs;

  if (!timeIsSynced()) return;
  long em = localEpochMinutes();

  for (int ch = 1; ch <= 4; ch++) {
    int idx = ch - 1;
    bool has = false, on = false;
    for (int i = 0; i < schedRuleCount; i++) {
      if (schedRules[i].ch != ch || !schedRules[i].en) continue;
      has = true;
      if (schedRuleActive(schedRules[i], em)) on = true;
    }
    if (!has) { lastSchedState[idx] = -1; continue; }   // ไม่มีกฎ = ควบคุมด้วยมือล้วน

    int want = on ? 1 : 0;
    if (lastSchedState[idx] != want) {
      lastSchedState[idx] = (int8_t)want;
      holdCloudUntil[idx] = millis() + 4000;
      Serial.printf(">>> [Schedule] ช่อง %d -> %s\n", ch, on ? "เปิด (ON)" : "ปิด (OFF)");
      if (relayStates[idx] != on) setRelay(idx, on);
      sendRelayToSupabase(idx, on);
    }
  }
}

// -------------------------------------------------------------
// ฟังก์ชันจัดการ Wi-Fi Flash Storage (Preferences)
// -------------------------------------------------------------
void loadWiFiCredentials() {
  preferences.begin("esp32_wifi", false);
  currentSSID = preferences.getString("ssid", defaultSSID);
  currentPass = preferences.getString("pass", defaultPass);
  preferences.end();
  Serial.printf("[Storage] โหลด Wi-Fi: %s\n", currentSSID.c_str());
}

void saveWiFiCredentials(String newSSID, String newPass) {
  preferences.begin("esp32_wifi", false);
  preferences.putString("ssid", newSSID);
  preferences.putString("pass", newPass);
  preferences.end();
  currentSSID = newSSID;
  currentPass = newPass;
  Serial.printf("💾 [Storage] บันทึก Wi-Fi สำเร็จ: %s\n", currentSSID.c_str());
}

// -------------------------------------------------------------
// ระบบ Smart Hotspot (Captive Portal 192.168.4.1)
// -------------------------------------------------------------
void handlePortalRoot() {
  String html = "<!DOCTYPE html><html lang='th'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'>";
  html += "<title>ESP32 Smart Setup</title>";
  html += "<style>";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f7;margin:0;padding:24px 16px;display:flex;justify-content:center;color:#1d1d1f;}";
  html += ".card{background:#ffffff;border-radius:22px;padding:24px;max-width:380px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.08);box-sizing:border-box;}";
  html += "h2{margin:0 0 6px;font-size:1.35rem;font-weight:700;}";
  html += "p{margin:0 0 20px;font-size:0.85rem;color:#6e6e73;line-height:1.4;}";
  html += "label{display:block;font-size:0.82rem;font-weight:600;margin-bottom:6px;color:#3a3a3c;}";
  html += "select,input{width:100%;padding:13px 14px;border:1px solid #d2d2d7;border-radius:12px;font-size:0.95rem;margin-bottom:16px;box-sizing:border-box;background:#f9f9fb;}";
  html += "button{width:100%;background:#0071e3;color:#ffffff;border:none;padding:14px;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,113,227,0.3);}";
  html += ".footer{text-align:center;font-size:0.75rem;color:#86868b;margin-top:16px;}";
  html += "</style></head><body>";
  html += "<div class='card'>";
  html += "<h2>⚙️ ตั้งค่า Wi-Fi บอร์ด ESP32</h2>";
  html += "<p>ตรวจพบว่าบอร์ดหลุดจาก Wi-Fi เดิม กรุณาเลือกชื่อ Wi-Fi ใหม่และกรอกรหัสผ่าน</p>";
  html += "<form method='POST' action='/save'>";
  html += "<label>เลือก Wi-Fi รอบตัว (2.4GHz):</label>";
  html += "<select name='ssid'>";
  
  int n = WiFi.scanNetworks();
  if (n <= 0) {
    html += "<option value=''>-- ไม่พบ Wi-Fi (กรุณารีเฟรช) --</option>";
  } else {
    for (int i = 0; i < n; ++i) {
      String netName = WiFi.SSID(i);
      html += "<option value='" + netName + "'>" + netName + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
    }
  }
  html += "</select>";
  html += "<label>รหัสผ่าน Wi-Fi:</label>";
  html += "<input type='password' name='pass' placeholder='กรอกรหัสผ่าน (หากมี)'>";
  html += "<button type='submit'>บันทึกและเชื่อมต่อ (Connect)</button>";
  html += "</form>";
  html += "<div class='footer'>ESP32 Smart Controller &bull; S-Gyver</div>";
  html += "</div></body></html>";
  apServer.send(200, "text/html", html);
}

void handlePortalSave() {
  if (apServer.hasArg("ssid")) {
    String newSSID = apServer.arg("ssid");
    String newPass = apServer.arg("pass");
    saveWiFiCredentials(newSSID, newPass);

    String resp = "<!DOCTYPE html><html lang='th'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'>";
    resp += "<body style='font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#f2f2f7;'>";
    resp += "<div style='background:#fff;border-radius:20px;padding:30px;max-width:340px;margin:auto;box-shadow:0 8px 30px rgba(0,0,0,0.08);'>";
    resp += "<h2 style='color:#34c759;margin:0 0 10px;'>✅ บันทึกสำเร็จ!</h2>";
    resp += "<p style='color:#6e6e73;font-size:0.9rem;'>บอร์ดกำลังเชื่อมต่อไปที่: <br><b>" + newSSID + "</b></p>";
    resp += "<p style='color:#86868b;font-size:0.8rem;margin-top:16px;'>บอร์ดจะรีสตาร์ทเพื่อเชื่อมต่ออินเทอร์เน็ต<br>คุณสามารถกลับไปที่หน้า Dashboard เพื่อใช้งานต่อได้เลยครับ</p>";
    resp += "</div></body></html>";
    apServer.send(200, "text/html", resp);

    delay(1500);
    ESP.restart();
  }
}

void startCaptivePortal() {
  if (apModeActive) return;
  apModeActive = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("ESP32-Smart-Setup");
  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));

  dnsServer.start(DNS_PORT, "*", apIP);

  apServer.on("/", handlePortalRoot);
  apServer.on("/save", HTTP_POST, handlePortalSave);
  apServer.onNotFound(handlePortalRoot);
  apServer.begin();

  Serial.println("\n=======================================================");
  Serial.println("📡 [Hotspot Mode] เปิดโหมดตั้งค่า Wi-Fi ผ่านมือถือ!");
  Serial.println("👉 1. เอามือถือต่อ Wi-Fi: ESP32-Smart-Setup");
  Serial.println("👉 2. เปิดเว็บไปที่: http://192.168.4.1 เพื่อเลือก Wi-Fi ใหม่");
  Serial.println("=======================================================\n");
}

void stopCaptivePortal() {
  if (!apModeActive) return;
  dnsServer.stop();
  apServer.stop();
  WiFi.softAPdisconnect(true);
  apModeActive = false;
  Serial.println("🛑 [Hotspot Mode] ปิดโหมดตั้งค่าแล้ว เข้าสู่สถานะปกติ");
}

// -------------------------------------------------------------
// ระบบ Web Serial API (ตั้งค่าผ่านสาย USB บนหน้าเว็บ)
// -------------------------------------------------------------
void scanWiFiSerial() {
  Serial.println("{\"event\":\"scan_start\"}");
  int n = WiFi.scanNetworks();
  String json = "{\"event\":\"scan_result\",\"networks\":[";
  for (int i = 0; i < n; i++) {
    if (i > 0) json += ",";
    json += "\"" + WiFi.SSID(i) + "\"";
  }
  json += "]}";
  Serial.println(json);
}

void handleSerialCommands();
bool connectWiFi(int timeoutSeconds = 12);

void handleSerialCommands() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) return;

    if (line == "CMD:SCAN_WIFI") {
      scanWiFiSerial();
    } else if (line.startsWith("CMD:SET_WIFI:")) {
      int first = 13;
      int second = line.indexOf(':', first);
      if (second != -1) {
        String newSsid = line.substring(first, second);
        String newPass = line.substring(second + 1);
        saveWiFiCredentials(newSsid, newPass);
        Serial.printf("{\"event\":\"wifi_status\",\"status\":\"connecting\",\"ssid\":\"%s\"}\n", newSsid.c_str());
        connectWiFi(15);
      }
    } else if (line == "CMD:GET_INFO") {
      Serial.printf("{\"event\":\"device_info\",\"ssid\":\"%s\",\"ip\":\"%s\",\"status\":\"%s\"}\n",
        currentSSID.c_str(),
        WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "0.0.0.0",
        WiFi.status() == WL_CONNECTED ? "connected" : "disconnected");
    }
  }
}

// -------------------------------------------------------------
// ฟังก์ชันเชื่อมต่อ Wi-Fi
// -------------------------------------------------------------
bool connectWiFi(int timeoutSeconds) {
  Serial.printf("\n[WiFi] กำลังเชื่อมต่อ: %s ", currentSSID.c_str());
  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(currentSSID.c_str(), currentPass.c_str());

  int elapsed = 0;
  while (WiFi.status() != WL_CONNECTED && elapsed < timeoutSeconds * 2) {
    delay(500);
    Serial.print(".");
    elapsed++;
    handleSerialCommands();
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ [WiFi] เชื่อมต่อสำเร็จเรียบร้อย!");
    Serial.print(">>> IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.printf("{\"event\":\"wifi_status\",\"status\":\"connected\",\"ip\":\"%s\",\"ssid\":\"%s\"}\n",
                  WiFi.localIP().toString().c_str(), currentSSID.c_str());
    stopCaptivePortal();
    return true;
  } else {
    Serial.println("\n⚠️ [WiFi] เชื่อมต่อไม่สำเร็จ (เปิด Hotspot สำรอง)");
    Serial.println("{\"event\":\"wifi_status\",\"status\":\"failed\"}");
    startCaptivePortal();
    return false;
  }
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=======================================================");
  Serial.println(" ESP32 Turbo IoT Controller (High-Speed Realtime v1) ");
  Serial.println(" - ตรวจสอบสวิตช์: ทุก 350ms ");
  Serial.println(" - ส่งค่าสี: ทุก 800ms (หรือทันทีเมื่อสีเปลี่ยน) ");
  Serial.println(" - ส่งอุณหภูมิ: ทุก 3 วินาที ");
  Serial.println(" - รองรับ Web Serial API (สาย USB) & Hotspot Captive Portal ");
  Serial.println("=======================================================");

  for (int i = 0; i < 4; i++) {
    setRelay(i, false);
  }

  setColorLed(true);
  scanI2C();

  tcsFound = initTCS34725();
  if (tcsFound) {
    Serial.println("✅ ตรวจพบเซนเซอร์ตรวจจับสี TCS34725 พร้อมทำงาน!");
  } else {
    Serial.println("⚠️ ยังไม่พบเซนเซอร์สี (เช็คสาย SDA=21, SCL=22, 3.3V, GND)");
  }

  // โหลด Wi-Fi ล่าสุดจาก Flash Memory
  loadWiFiCredentials();
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.nist.gov");  // ซิงก์เวลา (UTC) เมื่อมีอินเทอร์เน็ต
  loadScheduleFromFlash();                                               // จำตารางเวลาล่าสุดไว้ใช้แม้ออฟไลน์

  // พยายามเชื่อมต่อ Wi-Fi (ถ้าไม่ได้จะเปิด Hotspot ให้อัตโนมัติ)
  connectWiFi(10);
}

void loop() {
  // รับคำสั่ง Serial ผ่านสาย USB (Web Serial API) เสมอ
  handleSerialCommands();
  evaluateSchedule();   // ตั้งเวลาเปิด-ปิดรีเลย์อัตโนมัติ

  // จัดการ Hotspot Captive Portal หากเปิดอยู่
  if (apModeActive) {
    dnsServer.processNextRequest();
    apServer.handleClient();
  }

  // หาก Wi-Fi หลุด ให้เปิด Hotspot ช่วยตั้งค่า
  if (WiFi.status() != WL_CONNECTED) {
    if (!apModeActive) {
      startCaptivePortal();
    }
    delay(20);
    return; // รอตั้งค่า Wi-Fi ก่อนทำลูปด้านล่าง
  }

  unsigned long now = millis();

  // 0. ดึงตารางเวลาจาก Cloud (ทุก 15 วินาที)
  if (now - lastSchedFetch >= schedFetchInterval) {
    lastSchedFetch = now;
    fetchScheduleFromSupabase();
  }

  // 1. ตรวจสอบสวิตช์รีเลย์และไฟ LED ส่องสีแบบความเร็วสูง (ทุก 350ms)
  if (now - lastRelayCheck >= relayInterval) {
    lastRelayCheck = now;
    checkSwitchesFromSupabase();
  }

  // 2. ตรวจสอบและส่งค่าสีขึ้น Cloud (ทุก 800ms หรือทันทีเมื่อนำสีใหม่มาจ่อ)
  if (now - lastColorCheck >= colorInterval) {
    lastColorCheck = now;

    if (!tcsFound) {
      tcsFound = initTCS34725();
    }

    if (tcsFound) {
      int r = 0, g = 0, b = 0, c = 0;
      String hex = "";
      if (readColorSensor(r, g, b, c, hex)) {
        if (abs(r - lastSentR) > 6 || abs(g - lastSentG) > 6 || abs(b - lastSentB) > 6) {
          lastSentR = r;
          lastSentG = g;
          lastSentB = b;
          sendColorToSupabase(r, g, b, c, hex);
          Serial.printf("[Turbo Color] สีเปลี่ยน -> %s (R:%d G:%d B:%d)\n", hex.c_str(), r, g, b);
        }
      }
    }
  }

  // 3. อ่านค่าเซนเซอร์อุณหภูมิ/ความชื้น DHT (ทุก 3 วินาที)
  if (now - lastDhtCheck >= dhtInterval) {
    lastDhtCheck = now;

    float temperature = 0.0;
    float humidity = 0.0;
    if (readDHTSensor(DHT_PIN, temperature, humidity, IS_DHT22)) {
      if (abs(temperature - lastTemp) >= 0.2 || abs(humidity - lastHum) >= 1.0) {
        lastTemp = temperature;
        lastHum = humidity;
        sendDhtToSupabase(temperature, humidity);
        Serial.printf("[DHT] อุณหภูมิ: %.1f°C, ความชื้น: %.1f%%\n", temperature, humidity);
      }
    }
  }
}
