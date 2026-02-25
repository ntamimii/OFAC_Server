const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs-extra");
const archiver = require("archiver");

// Import checker function
const { runChecker } = require("./checker.js");

const app = express();
const PORT = 3000;

// Set up upload folder
const upload = multer({ dest: path.join(__dirname, "uploads/") });

// Serve static files (HTML page + CSS/JS)
app.use(express.static(path.join(__dirname, "public")));

// Temporary folder for scan results
const TEMP_FOLDER = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);

// ===== SSE connection =====
let currentSSE = null;

app.get("/upload-progress", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  currentSSE = res;

  req.on("close", () => {
    console.log("SSE connection closed");
    currentSSE = null;
  });
});

// ===== Upload & Scan Route =====
app.post("/upload", upload.single("publishers"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");

  const uploadedPath = req.file.path;
  console.log("File uploaded:", uploadedPath);

  try {
    // Run checker and send live progress via SSE
    const resultsFolder = await runChecker(
      uploadedPath,
      TEMP_FOLDER,
      (current, total, publisherName, extraText = "") => {
        if (currentSSE) {
          currentSSE.write(
            `data: ${JSON.stringify({
              current,
              total,
              status:
                extraText ||
                `Processing "${publisherName}" (${current}/${total})...`,
            })}\n\n`,
          );
        }
      },
    );

    // Create ZIP of results
    const zipName = `${path.basename(resultsFolder)}.zip`;
    const zipPath = path.join(TEMP_FOLDER, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);
    archive.directory(resultsFolder, false);
    await archive.finalize();

    // Clean up uploaded XLSX
    fs.removeSync(uploadedPath);

    // Notify frontend scan is done
    if (currentSSE) {
      currentSSE.write(
        `data: ${JSON.stringify({ done: true, zipFilename: zipName })}\n\n`,
      );
      currentSSE.end();
      currentSSE = null;
    }

    // Respond to POST (optional)
    res.json({ zipFilename: zipName });
  } catch (err) {
    console.error("Error running checker:", err);
    res.status(500).send("Error processing the file. Check server logs.");
  }
});

// ===== Download Route =====
app.get("/download/:zip", (req, res) => {
  const zipPath = path.join(TEMP_FOLDER, req.params.zip);
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, req.params.zip, (err) => {
      if (err) console.error("Error sending zip:", err);
      fs.removeSync(zipPath);
    });
  } else {
    res.status(404).send("File not found.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
