// checker.js (Single-browser version, screenshots for ALL, JSON for ALL)
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer");
// Use Render's system Chrome if available
const CHROME_PATH = process.env.CHROME_PATH || null;

// ===== CONFIG =====
const CSV_FOLDER = "./data"; // folder containing SDN + ALT CSVs
const SAVE_JSON_RESPONSES = true;
const MAX_CELL_LENGTH = 32000; // safety margin for Excel
const OFAC_URL = "https://sanctionssearch.ofac.treas.gov/";

// ===== Helper: normalize text =====
function normalizeText(text) {
  if (!text) return "";
  return text
    .toString()
    .toUpperCase()
    .replace(/[\.,\-']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ===== Load all CSVs in folder and flatten all values =====
async function loadCSVFolder(folder) {
  const files = fs.readdirSync(folder).filter((f) => f.endsWith(".csv"));
  if (!files.length) throw new Error("No CSV files found in folder.");

  const entries = [];

  for (const file of files) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(path.join(folder, file))
        .pipe(csv())
        .on("data", (row) => {
          Object.values(row).forEach((val) => {
            const normalized = normalizeText(val);
            if (normalized) entries.push(normalized);
          });
        })
        .on("end", resolve)
        .on("error", reject);
    });
  }

  if (!entries.length) throw new Error("No entries loaded from CSVs.");

  return entries.map((name, i) => ({
    id: `entry_${i + 1}`,
    name,
    words: name.split(" "),
  }));
}

// ===== Full-word fuzzy search =====
function searchName(publisherName, entries) {
  const pubWords = normalizeText(publisherName).split(" ");

  return entries
    .map((entry) => {
      const matchedWords = pubWords.filter((pw) =>
        entry.words.some((ew) => ew.startsWith(pw)),
      );
      const score = matchedWords.length / pubWords.length;
      if (score === 1) return { id: entry.id, matchedName: entry.name, score };
      return null;
    })
    .filter(Boolean);
}

// ===== Puppeteer screenshot using a shared page =====
async function takeScreenshot(name, filepath, page) {
  if (!name) return;

  await page.goto(OFAC_URL, { waitUntil: "domcontentloaded", timeout: 20000 });

  // Clear previous input
  await page.evaluate(() => {
    const input = document.querySelector("#ctl00_MainContent_txtLastName");
    if (input) input.value = "";
  });

  await page.type("#ctl00_MainContent_txtLastName", name);
  await page.click("#ctl00_MainContent_btnSearch");

  await page
    .waitForSelector("#ctl00_MainContent_gvResults", { timeout: 7000 })
    .catch(() => console.log(`No results table for "${name}"`));

  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot saved: ${filepath}`);
}

// ===== EXPORTABLE FUNCTION =====
async function runChecker(
  publishersFilePath,
  downloadsFolder,
  progressCallback,
) {
  console.log("Loading SDN + ALT lists...");
  const screeningEntries = await loadCSVFolder(CSV_FOLDER);
  console.log(`Loaded ${screeningEntries.length} entries from CSVs.`);

  // Load uploaded publishers file
  const workbook = XLSX.readFile(publishersFilePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const publishers = XLSX.utils.sheet_to_json(sheet).map((r) => ({
    Name: r["Name as per Bank Account"] || r["Name"] || "",
  }));

  const total = publishers.length;

  // Create timestamped results folder
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsFolder = path.join(downloadsFolder, `OFAC Results ${timestamp}`);
  if (!fs.existsSync(resultsFolder)) fs.mkdirSync(resultsFolder);

  const screenshotsFolder = path.join(resultsFolder, "screenshots");
  if (!fs.existsSync(screenshotsFolder)) fs.mkdirSync(screenshotsFolder);

  let responsesFolder = null;
  if (SAVE_JSON_RESPONSES) {
    responsesFolder = path.join(resultsFolder, "responses");
    if (!fs.existsSync(responsesFolder)) fs.mkdirSync(responsesFolder);
  }

  // ===== Launch single Puppeteer browser =====
  console.log("Launching Chromium...");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH, // <-- add this
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });
  const page = await browser.newPage();

  const results = [];

  for (let i = 0; i < total; i++) {
    const pub = publishers[i];
    const safeName = (pub.Name || "EMPTY").replace(/[^a-zA-Z0-9]/g, "_");

    if (progressCallback)
      progressCallback(i + 1, total, pub.Name, "Searching SDN/ALT lists");
    console.log(`Processing "${pub.Name}" (${i + 1}/${total})...`);

    const matches = searchName(pub.Name, screeningEntries);
    const status = matches.length > 0 ? "MATCH" : "CLEAR";

    // Save JSON for ALL
    if (SAVE_JSON_RESPONSES) {
      const jsonPath = path.join(responsesFolder, `${safeName}_${i + 1}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(matches, null, 2));
    }

    // Take screenshot for ALL
    const screenshotPath = path.join(
      screenshotsFolder,
      `${safeName}_${i + 1}.png`,
    );
    try {
      if (progressCallback)
        progressCallback(
          i + 1,
          total,
          pub.Name,
          `Taking screenshot for "${pub.Name}"`,
        );
      await takeScreenshot(pub.Name, screenshotPath, page);
    } catch (err) {
      console.error(`Screenshot error for "${pub.Name}":`, err.message);
    }

    const screenshotLink = `./screenshots/${safeName}_${i + 1}.png`;

    let matchesString = matches
      .map((m) => `${m.matchedName} (score: ${m.score.toFixed(2)})`)
      .join("; ");
    if (matchesString.length > MAX_CELL_LENGTH) {
      matchesString =
        matchesString.slice(0, MAX_CELL_LENGTH) + " ...[truncated]";
    }

    results.push({
      Publisher: pub.Name,
      MatchStatus: status,
      MatchCount: matches.length,
      Matches: matchesString,
      Screenshot: { text: "View Screenshot", hyperlink: screenshotLink },
    });
  }

  await browser.close();

  // ===== Save Excel =====
  const workbookOut = XLSX.utils.book_new();
  const sheetData = results.map((r) => ({
    Publisher: r.Publisher,
    MatchStatus: r.MatchStatus,
    MatchCount: r.MatchCount,
    Matches: r.Matches,
    Screenshot: r.Screenshot,
  }));
  const sheetOut = XLSX.utils.json_to_sheet(sheetData);

  results.forEach((r, idx) => {
    if (r.Screenshot) {
      const cellAddress = `E${idx + 2}`;
      sheetOut[cellAddress] = {
        t: "s",
        v: r.Screenshot.text,
        l: { Target: r.Screenshot.hyperlink },
      };
    }
  });

  XLSX.utils.book_append_sheet(workbookOut, sheetOut, "OFAC_Results");
  XLSX.writeFile(workbookOut, path.join(resultsFolder, "OFAC_Results.xlsx"));

  console.log(`✅ Screening complete. Results saved in: ${resultsFolder}`);
  if (SAVE_JSON_RESPONSES)
    console.log("JSON responses saved inside responses folder.");

  return resultsFolder;
}

module.exports = { runChecker };
