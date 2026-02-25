// checker.js (CommonJS version with progress callback)
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer");

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

// ===== Puppeteer screenshot for OFAC search =====
async function takeScreenshot(name, filepath) {
  async function takeScreenshot(name, filepath) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
        ],
      });

      const page = await browser.newPage();
      await page.goto(OFAC_URL, { waitUntil: "networkidle2" });

      await page.type("#ctl00_MainContent_txtLastName", name);
      await page.click("#ctl00_MainContent_btnSearch");

      // Wait for results table or short timeout
      await page
        .waitForSelector("#ctl00_MainContent_gvResults", { timeout: 5000 })
        .catch(() => console.log("No results table appeared, continuing..."));

      await page.screenshot({ path: filepath, fullPage: true });

      await browser.close();
    } catch (err) {
      console.error(`Screenshot error for "${name}":`, err.message);
    }
  }

  const page = await browser.newPage();
  await page.goto(OFAC_URL, { waitUntil: "networkidle2" });

  await page.type("#ctl00_MainContent_txtLastName", name);
  await page.click("#ctl00_MainContent_btnSearch");

  // Wait a bit for results to load
  await page
    .waitForSelector("#ctl00_MainContent_gvResults", { timeout: 5000 })
    .catch(() => console.log("No results table appeared, continuing..."));

  await page.screenshot({ path: filepath, fullPage: true });

  await browser.close();
}

// ===== EXPORTABLE FUNCTION =====
// progressCallback(currentIndex, total, publisherName) – optional
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
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const resultsFolder = path.join(downloadsFolder, `OFAC Results ${timestamp}`);
  if (!fs.existsSync(resultsFolder)) fs.mkdirSync(resultsFolder);

  const screenshotsFolder = path.join(resultsFolder, "screenshots");
  if (!fs.existsSync(screenshotsFolder)) fs.mkdirSync(screenshotsFolder);

  let responsesFolder = null;
  if (SAVE_JSON_RESPONSES) {
    responsesFolder = path.join(resultsFolder, "responses");
    if (!fs.existsSync(responsesFolder)) fs.mkdirSync(responsesFolder);
  }

  const results = [];

  for (let i = 0; i < total; i++) {
    const pub = publishers[i];

    if (progressCallback)
      progressCallback(
        i + 1,
        total,
        pub.Name,
        `Processing "${pub.Name}" (${i + 1}/${total})...`,
      );

    console.log(`Processing "${pub.Name}" (${i + 1}/${total})...`);

    const matches = searchName(pub.Name, screeningEntries);
    const status = matches.length > 0 ? "MATCH" : "CLEAR";

    let screenshotLink = "";
    if (SAVE_JSON_RESPONSES && matches.length > 0) {
      const safeName = pub.Name.replace(/\s+/g, "_");

      // Save JSON
      const jsonPath = path.join(responsesFolder, `${safeName}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(matches, null, 2));

      // Take screenshot
      const screenshotPath = path.join(screenshotsFolder, `${safeName}.png`);
      try {
        if (progressCallback)
          progressCallback(
            i + 1,
            total,
            pub.Name,
            `Taking OFAC screenshot for "${pub.Name}"`,
          );
        console.log(`Taking OFAC screenshot for "${pub.Name}"...`);
        await takeScreenshot(pub.Name, screenshotPath);
        console.log(`Screenshot saved: ${screenshotPath}`);
        screenshotLink = `./screenshots/${safeName}.png`;
      } catch (err) {
        console.error("Screenshot error:", err.message);
      }
    }

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
      Screenshot: screenshotLink
        ? { text: "View Screenshot", hyperlink: screenshotLink }
        : "",
    });
  }

  // Save Excel with clickable links
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

  console.log(
    `✅ Screening complete. Results saved in folder: ${resultsFolder}`,
  );
  if (SAVE_JSON_RESPONSES)
    console.log("Matched JSON responses saved inside responses folder.");

  return resultsFolder;
}

module.exports = { runChecker };
