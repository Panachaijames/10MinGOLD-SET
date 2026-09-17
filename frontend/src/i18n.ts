import { useCallback, useEffect, useState } from "react";

/**
 * English and Thai for the whole interface.
 *
 * The dictionary is keyed by the English source text rather than by invented ids, so a string in
 * the JSX still reads as the sentence it renders and a missing translation falls back to English
 * instead of showing a key. Instrument names (XAUUSDm, GOLD.wis, SET:EA, BTCUSDT) and indicator
 * names (MACD, RSI) are deliberately absent: traders use them untranslated in both languages.
 */
export type Lang = "en" | "th";

const TH: Record<string, string> = {
  // chrome and hero
  "Aurum Signal": "Aurum Signal",
  "Confirmed MACD watcher": "ตัวเฝ้าดู MACD ที่ยืนยันแล้ว",
  "Watching the close.": "เฝ้าดูราคาปิด",
  "Alerts fire only after a candle is complete, so the signal does not repaint.":
    "แจ้งเตือนเมื่อแท่งเทียนปิดสมบูรณ์แล้วเท่านั้น สัญญาณจึงไม่เปลี่ยนย้อนหลัง",
  "Polling": "รอบการดึงข้อมูล",
  "Offline": "ออฟไลน์",
  "Live": "เรียลไทม์",
  "Market paused": "ตลาดหยุดพัก",
  "Online": "ออนไลน์",

  // access and sign in
  "Private access": "เข้าใช้งานส่วนตัว",
  "Connect your watcher": "เชื่อมต่อตัวเฝ้าดูของคุณ",
  "Sign in with the watcher account created in Supabase Auth.":
    "เข้าสู่ระบบด้วยบัญชีที่สร้างไว้ใน Supabase Auth",
  "Or enter a passcode the owner gave you.": "หรือกรอกรหัสผ่านที่เจ้าของให้ไว้",
  "Enter the same": "กรอกค่าเดียวกับ",
  "Connect": "เชื่อมต่อ",
  "Sign in": "เข้าสู่ระบบ",
  "Signing in…": "กำลังเข้าสู่ระบบ…",
  "Use passcode": "ใช้รหัสผ่าน",
  "Checking…": "กำลังตรวจสอบ…",
  "Sign out": "ออกจากระบบ",
  "Email": "อีเมล",
  "Password": "รหัสผ่าน",
  "Passcode": "รหัสผ่าน",
  "App token": "โทเคนแอป",

  // passcode admin
  "Access": "สิทธิ์เข้าใช้งาน",
  "Passcodes": "รหัสผ่าน",
  "Expires in": "หมดอายุใน",
  "days": "วัน",
  "Generate": "สร้างรหัส",
  "Copy it now. Only its hash is stored, so it cannot be shown again.":
    "คัดลอกทันที ระบบเก็บเฉพาะค่าแฮช จึงไม่สามารถแสดงรหัสนี้ได้อีก",
  "Revoke": "ยกเลิก",
  "Remove": "นำออก",
  "Who is it for?": "สำหรับใคร",
  "Passcode label": "ชื่อกำกับรหัสผ่าน",
  "unclaimed": "ยังไม่ถูกใช้",
  "cancelled": "ถูกยกเลิก",
  "expired": "หมดอายุ",
  "used up": "ใช้ไปแล้ว",
  "no expiry": "ไม่มีวันหมดอายุ",
  "active": "ใช้งานอยู่",
  "claimed": "ใช้เมื่อ",
  "until": "ถึง",
  "joined": "เข้าร่วมเมื่อ",
  "Change token": "เปลี่ยนโทเคน",
  "revoked": "ถูกยกเลิก",

  // notifications
  "LINE Messaging API": "LINE Messaging API",
  "Add Aurum Signal Bot": "เพิ่มบอท Aurum Signal",
  "Scan this QR code with your phone or tap the button to add the bot on LINE.":
    "สแกน QR นี้ด้วยมือถือ หรือกดปุ่มเพื่อเพิ่มบอทใน LINE",
  "Open in LINE": "เปิดใน LINE",
  "Scan the QR code with your LINE app or tap": "สแกน QR ด้วยแอป LINE หรือกด",
  "Tap": "กด",
  "Add Friend": "เพิ่มเพื่อน",
  "Test LINE Alert": "ทดสอบแจ้งเตือน LINE",
  "Test LINE": "ทดสอบ LINE",
  "Testing…": "กำลังทดสอบ…",
  "Phone QR": "QR สำหรับมือถือ",
  "Install app": "ติดตั้งแอป",
  "Browser test": "ทดสอบเบราว์เซอร์",
  "Browser push": "แจ้งเตือนผ่านเบราว์เซอร์",
  "Mute web": "ปิดเสียงบนเว็บ",
  "Enable notifications": "เปิดการแจ้งเตือน",
  "Connecting…": "กำลังเชื่อมต่อ…",
  "Sending…": "กำลังส่ง…",
  "Open on another device": "เปิดบนอุปกรณ์อื่น",
  "Scan to open Aurum Signal": "สแกนเพื่อเปิด Aurum Signal",
  "Generating QR…": "กำลังสร้าง QR…",
  "Close QR code": "ปิด QR",
  "Done": "เสร็จสิ้น",
  "Dismiss": "ปิด",
  "Android:": "แอนดรอยด์:",
  "Open the installed icon, sign in, and tap Enable notifications.":
    "เปิดไอคอนที่ติดตั้งไว้ เข้าสู่ระบบ แล้วกดเปิดการแจ้งเตือน",
  "Open on phone (QR)": "เปิดบนมือถือ (QR)",
  "Test LINE Messaging API notification": "ทดสอบการแจ้งเตือนผ่าน LINE Messaging API",
  "Optional: receive browser notifications on this PC":
    "ตัวเลือกเสริม: รับการแจ้งเตือนบนเครื่องนี้",

  // cloud health
  "Cloud health": "สถานะระบบคลาวด์",
  "Heartbeats": "สัญญาณชีพ",
  "Laptop watcher": "ตัวเฝ้าดูบนโน้ตบุ๊ก",
  "Cloud failover": "ระบบสำรองบนคลาวด์",
  "SET scanner": "ตัวสแกนหุ้นไทย",
  "TradingView alert": "แจ้งเตือนจาก TradingView",
  "Push fan-out": "การกระจายแจ้งเตือน",

  // indicators and charts
  "Live indicators": "ตัวชี้วัดแบบเรียลไทม์",
  "Closed candles": "แท่งเทียนที่ปิดแล้ว",
  "Confirmed candle": "แท่งเทียนที่ยืนยันแล้ว",
  "Waiting for the first MT5 candle snapshot…": "กำลังรอข้อมูลแท่งเทียนชุดแรกจาก MT5…",
  "Chart": "กราฟ",
  "Chart layout": "รูปแบบการจัดกราฟ",
  "Indicators": "ตัวชี้วัด",
  "Full screen": "เต็มจอ",
  "Exit full screen": "ออกจากเต็มจอ",
  "Close": "ปิด",
  "Signal": "เส้นสัญญาณ",
  "Histogram": "ฮิสโตแกรม",
  "This chart is not available on the local backend": "กราฟนี้ใช้ไม่ได้บนเซิร์ฟเวอร์ในเครื่อง",
  "Choose a gold timeframe, or open the Supabase deployment for SET and Bitcoin.":
    "เลือกไทม์เฟรมของทองคำ หรือเปิดผ่าน Supabase เพื่อดูหุ้นไทยและบิตคอยน์",

  // watchlist
  "Watchlist": "รายการเฝ้าดู",
  "Your instruments · M5 to D1 · no setup needed": "หลักทรัพย์ของคุณ · M5 ถึง D1 · ไม่ต้องตั้งค่าเพิ่ม",
  "Search any symbol: PTT, AAPL, BTCUSDT…": "ค้นหาหลักทรัพย์ใดก็ได้: PTT, AAPL, BTCUSDT…",
  "Search instruments": "ค้นหาหลักทรัพย์",
  "Timeframe for the instrument you add": "ไทม์เฟรมของหลักทรัพย์ที่เพิ่ม",
  "Searching…": "กำลังค้นหา…",
  "No instrument matched that search.": "ไม่พบหลักทรัพย์ที่ตรงกับคำค้นนี้",
  "added. The next scan covers it.": "เพิ่มแล้ว ระบบจะเริ่มเฝ้าดูในรอบสแกนถัดไป",
  "Nothing on your list yet. Search above to add an instrument.":
    "ยังไม่มีรายการ ค้นหาด้านบนเพื่อเพิ่มหลักทรัพย์",
  "Instrument": "หลักทรัพย์",
  "Timeframe": "ไทม์เฟรม",
  "delayed": "ดีเลย์",
  "feed error": "ข้อมูลผิดพลาด",

  // SET table
  "SET stocks · 15m · TradingView (15-min delayed)": "หุ้นไทย · 15 นาที · TradingView (ดีเลย์ 15 นาที)",
  "MACD by ticker": "MACD แยกตามหลักทรัพย์",
  "Ticker": "หลักทรัพย์",
  "Hist": "ฮิสโตแกรม",
  "Last closed bar": "แท่งที่ปิดล่าสุด",
  "Feed": "แหล่งข้อมูล",
  "Closed bars · TradingView, delayed 15 minutes": "แท่งที่ปิดแล้ว · TradingView ดีเลย์ 15 นาที",
  "The cloud scanner will populate this chart with closed, delayed M15 bars.":
    "ตัวสแกนบนคลาวด์จะเติมกราฟนี้ด้วยแท่ง 15 นาทีที่ปิดแล้วแบบดีเลย์",

  // diagnostics and history
  "Measured delivery": "ผลการส่งที่วัดได้",
  "Latency diagnostics": "การวัดความหน่วง",
  "Median": "ค่ากลาง",
  "95th percentile": "เปอร์เซ็นไทล์ที่ 95",
  "Samples": "จำนวนตัวอย่าง",
  "Measured from the scheduled candle close to receipt by the device service worker.":
    "วัดจากเวลาที่แท่งเทียนปิดตามกำหนด จนถึงเวลาที่อุปกรณ์ได้รับ",
  "Audit trail": "บันทึกย้อนหลัง",
  "Alert history": "ประวัติการแจ้งเตือน",
  "No confirmed crossovers yet": "ยังไม่มีสัญญาณตัดกันที่ยืนยันแล้ว",
};

const STORAGE_KEY = "aurum-lang";

export function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "th" ? "th" : "en";
  } catch {
    return "en";
  }
}

// Module scope rather than context: small presentational components all over this file need to
// translate, and threading a provider through every one of them would add more plumbing than the
// feature is worth. Switching language re-renders the tree from the top, so every t() call is
// re-evaluated with the new language.
let current: Lang = readLang();

/** Translate one string. An untranslated string falls through as English rather than as a key. */
export function t(text: string): string {
  return current === "th" ? TH[text] ?? text : text;
}

export function useLang(): { lang: Lang; setLang: (next: Lang) => void } {
  const [lang, setLangState] = useState<Lang>(current);

  const setLang = useCallback((next: Lang) => {
    current = next;           // set before the re-render so this pass already reads the new one
    setLangState(next);
  }, []);

  useEffect(() => {
    current = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // A private window just loses the preference between visits.
    }
    document.documentElement.lang = lang;
  }, [lang]);

  return { lang, setLang };
}
