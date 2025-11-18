/**
 * Copyright (c) 2025 Khaled Farouk
 * Proprietary and Confidential
 */

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// Selenium
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// ==================== إعدادات عامة ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "supersecretkey";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY";
const ELECTION_URL = "https://www.elections.eg/inquiry";
const RESULTS_DIR = "./results";
const PUBLIC_DIR = "./public/assets";
const LOG_FILE = "./log.txt";
const MAX_BROWSERS = 3;
const QUEUE_INTERVAL = 500;

// مسارات Chrome / ChromeDriver (تقدر تغيّرها أو تستخدم متغيرات بيئة)
const isWin = process.platform === "win32";

const CHROME_BIN =
  process.env.CHROME_BIN ||
  (isWin
    ? path.join(__dirname, "chromebin-win", "chrome.exe")
    : path.join(__dirname, "chromebin-linux", "chrome"));

const CHROMEDRIVER_PATH =
  process.env.CHROMEDRIVER_PATH ||
  (isWin
    ? path.join(__dirname, "chromedriver-win", "chromedriver.exe")
    : path.join(__dirname, "chromedriver-linux", "chromedriver"));

// إنشاء المجلدات لو مش موجودة
for (const dir of [RESULTS_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ==================== دوال مساعدة ====================
function log(message) {
  const line = `[${new Date().toLocaleString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

function extractInfo(text) {
  const get = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return (m[1] || m[0]).trim();
    }
    return "";
  };

  return {
    polling_center: get([/مدرسة\s+[^\n\r]+/]),
    governorate: get([/المحافظة[:\s\-]*([^\n\r]+)/]),
    district: get([/قسم\s+[^\n\r]+/]),
    address: get([/العنوان[:\s\-]*([^\n\r]+)/]),
    sub_committee_number: get([/اللجنة[:\s\-]*([^\n\r]+)/]),
    list_number: get([/قائمة[:\s\-]*([^\n\r]+)/]),
    voting_date: get([/(\d+\s*-\s*\d+\\s*نوفمبر)/]),
    attendance_density: get([/الكثافة|متاحة\s+على\s+التطبيق[^\n\r]*/])
  };
}

// ==================== جلب اللوكيشن من Google Maps ====================
async function getSchoolLocation(info) {
  const schoolName = info.polling_center || "";
  const district = info.district || "";
  if (!schoolName) return null;

  const query = encodeURIComponent(`${schoolName} ${district} مصر`);

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${GOOGLE_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json();

    if (data.status === "OK" && data.results.length > 0) {
      const placeId = data.results[0].place_id;
      return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    } else {
      // fallback دائم بدل null
      return `https://www.google.com/maps/search/${query}`;
    }
  } catch (err) {
    // fallback دائم بدل null
    return `https://www.google.com/maps/search/${query}`;
  }
}

// ==================== إعداد Selenium + Pool ====================
let browserPool = [];
let busyBrowsers = new Set();

async function createBrowser() {
  // إعداد Chrome headless
  const options = new chrome.Options();
  if (CHROME_BIN) {
    options.setChromeBinaryPath(CHROME_BIN);
  }

  options.addArguments(
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu"
  );

  const service = new chrome.ServiceBuilder(CHROMEDRIVER_PATH).build();
  chrome.setDefaultService(service);

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  log("🔗 تم إنشاء متصفح Selenium جديد");
  return driver;
}

async function initBrowserPool() {
  log("🔧 جاري إنشاء pool المتصفحات (Selenium)...");
  for (let i = 0; i < MAX_BROWSERS; i++) {
    const browser = await createBrowser();
    browserPool.push(browser);
  }
  log(`✅ تم إنشاء ${browserPool.length} متصفح.`);
}

function getAvailableBrowser() {
  return browserPool.find((b) => !busyBrowsers.has(b));
}

// ==================== Queue System ====================
const queue = [];
let processingCount = 0;

function enqueue(task) {
  queue.push(task);
  log(`🕓 تمت إضافة استعلام جديد للطابور (الطول الحالي: ${queue.length})`);
  processQueue();
}

async function processQueue() {
  if (processingCount >= MAX_BROWSERS) return;

  const browser = getAvailableBrowser();
  if (!browser || queue.length === 0) return;

  const task = queue.shift();
  const { nid, callback_url, res, order } = task;
  processingCount++;
  busyBrowsers.add(browser);

  try {
    // تجهيز اسم ومسار الـ screenshot زى ما كان في الكود الأصلي
    const screenshotName = `${nid}_${Date.now()}.png`;
    const screenshotPath = path.join(PUBLIC_DIR, screenshotName);

    // استعلام موقع الانتخابات + screenshot
    const info = await queryElection(browser, nid, screenshotPath);
    const geo = await getSchoolLocation(info);

    const screenshotLink = `https://denisse-tombless-unseriously.ngrok-free.dev/assets/${screenshotName}`;

    const payload = {
      order,
      nid,
      timestamp: new Date().toISOString(),
      ...info,
      school_location: geo,
      screenshot_link: screenshotLink
    };

    const resultFile = path.join(RESULTS_DIR, `${nid}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(payload, null, 2), "utf8");

    log(`✅ [#${order}] تم حفظ النتيجة في ${resultFile}`);

    if (callback_url) {
      try {
        await fetch(callback_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        log(`📤 تم إرسال النتيجة إلى ${callback_url}`);
      } catch (err) {
        log(`⚠️ فشل إرسال callback إلى ${callback_url}: ${err.message}`);
      }
    }

    res.json({ ok: true, data: payload });
  } catch (err) {
    log(`❌ [#${order}] فشل تنفيذ الاستعلام ${nid}: ${err.message}`);
    res
      .status(500)
      .json({ ok: false, message: "Query failed", error: err.message });
  } finally {
    busyBrowsers.delete(browser);
    processingCount--;
    setTimeout(processQueue, QUEUE_INTERVAL);
  }
}

// ==================== الدالة الأساسية باستخدام Selenium ====================
async function queryElection(driver, nid, screenshotPath) {
  try {
    // افتح صفحة الاستعلام
    await driver.get(ELECTION_URL);

    // استنى iframe
    const iframeElement = await driver.wait(
      until.elementLocated(By.css("iframe")),
      8000
    );

    // ادخل جوه الـ iframe
    await driver.switchTo().frame(iframeElement);

    // استنى حقل الرقم القومي
    const nidInput = await driver.wait(
      until.elementLocated(By.css("#nid")),
      8000
    );
    await nidInput.clear();
    await nidInput.sendKeys(nid);

    // زر الإرسال
    const submitBtn = await driver.findElement(By.css("#submit_btn"));
    await submitBtn.click();

    // استنى النتيجة تظهر
    await driver.sleep(2500);

    // هات نص الجسم كله
    const body = await driver.findElement(By.css("body"));
    const text = await body.getText();
    const info = extractInfo(text);

    // Screenshot
    const imageBase64 = await driver.takeScreenshot();
    fs.writeFileSync(screenshotPath, imageBase64, "base64");

    // ارجع للصفحة الأساسية للاستعلام التالي
    await driver.switchTo().defaultContent();

    return info;
  } catch (err) {
    // حاول ترجع للـ default content عشان المتصفح يفضل صالح للاستعلامات التالية
    try {
      await driver.switchTo().defaultContent();
    } catch (_) {}
    throw err;
  }
}

// ==================== إعداد السيرفر ====================
const app = express();
app.use(bodyParser.json());

// خدمة الملفات الثابتة
app.use("/assets", express.static(path.join(__dirname, "public/assets")));

app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    log(`🚫 محاولة دخول غير مصرح بها من ${req.ip}`);
    return res.status(403).json({ ok: false, message: "Invalid API key" });
  }
  next();
});

let orderCounter = 1;

app.post("/query", (req, res) => {
  const { nid, callback_url } = req.body;

  if (!nid || !/^\d{14}$/.test(nid)) {
    log(`⚠️ طلب غير صالح: ${JSON.stringify(req.body)}`);
    return res
      .status(400)
      .json({ ok: false, message: "Invalid NID (must be 14 digits)" });
  }

  enqueue({ nid, callback_url, res, order: orderCounter++ });
});

app.get("/", (req, res) =>
  res.send("✅ API جاهز. استخدم POST /query مع x-api-key و nid.")
);

// ==================== بدء التشغيل ====================
app.listen(PORT, async () => {
  await initBrowserPool();
  log(`🚀 السيرفر شغال على http://localhost:${PORT}`);
  log(`🔑 استخدم API Key: ${API_KEY}`);
});
