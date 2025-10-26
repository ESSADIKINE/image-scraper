// scrape-botech.js
// Node.js 18+ required

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";
import sanitize from "sanitize-filename";

// ==============================
// 🔧 CONFIGURATION
// ==============================

const BASE_URL = "https://www.botech.ma/";
const OUTPUT_DIR = path.resolve("botech_images");

const FETCH_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

const CATEGORIES = {
  "Fauteuils Médicals": "prod/fauteuils-medicals-maroc",
  "Lits hospitaliers": "cat/lits-hospitaliers-maroc",
  "Matelas médical": "prod/matelas-medical-maroc",
  "Table de chevet": "prod/table-de-chevet-maroc",
  "Table à manger": "prod/table-a-manger-maroc",
  "Berceaux": "prod/berceaux-maroc",
  "Chariots brancards": "prod/chariots-brancards-maroc",
  "Divan d'examen": "prod/divan-d-examen-maroc",
  "Tabourets": "prod/tabourets-maroc",
  "Éclairage médical": "prod/eclairage-medical-maroc",
  "Chariots": "prod/chariots-maroc",
  "Gynécologie": "prod/gynecologie-maroc",
  "Paravents": "prod/paravents-maroc",
  "Armoire et vitrine": "prod/armoire-et-vitrine-maroc",
  "Rééducation et massage": "prod/reeduction-et-massage-maroc",
  "Mobilier de bureau": "cat/mobilier-de-bureau-maroc",
  "Mobilier laboratoire": "prod/mobilier-laboratoire-maroc",
  "Couveuses néonatales": "prod/couveuses-neonatales-maroc",
  "Tables chauffantes": "prod/tables-chauffantes-maroc",
  "Appareils de photothérapie": "prod/appareils-de-phototherapie-maroc",
  "Gaines tête de lit": "prod/gaines-tete-de-lit-maroc",
  "Éclairage opératoire": "prod/eclairage-operatoire-maroc",
  "Diagnostique": "prod/diagnostique-maroc",
};

// ==============================
// 🧠 UTILITAIRES
// ==============================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; BOTechScraper/1.0; +https://www.example.com/)"
  },
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400
});

const toAbs = (url) => {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url.replace(/^\.?\//, ""), BASE_URL).href;
};

const isImageUrl = (u) => /\.(jpe?g|png|webp)$/i.test(u.split("?")[0]);

const extFromUrl = (u) => {
  const clean = u.split("?")[0];
  const match = clean.match(/\.(jpe?g|png|webp)$/i);
  return match ? match[0].toLowerCase() : ".jpg";
};

const safeFileName = (name) =>
  sanitize(name).replace(/\s+/g, "_").slice(0, 150);

const uniq = (arr) => [...new Set(arr)];

// ==============================
// 🔁 RÉESSAIS & TÉLÉCHARGEMENTS
// ==============================

async function fetchWithRetry(url, opts = {}, attempt = 1) {
  try {
    return await client.get(url, opts);
  } catch (e) {
    if (attempt >= MAX_RETRIES) throw e;
    await sleep(RETRY_DELAY_MS * attempt);
    return fetchWithRetry(url, opts, attempt + 1);
  }
}

async function downloadFile(url, dest, attempt = 1) {
  await fs.ensureDir(path.dirname(dest));
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: { "User-Agent": client.defaults.headers["User-Agent"] }
    });
    await fs.writeFile(dest, res.data);
  } catch (e) {
    if (attempt >= MAX_RETRIES) {
      console.error("❌ Failed:", url, "->", dest, e.message);
      return;
    }
    await sleep(RETRY_DELAY_MS * attempt);
    return downloadFile(url, dest, attempt + 1);
  }
}

// ==============================
// 🔍 EXTRACTION HTML
// ==============================

function extractCategoryImages(html) {
  const $ = cheerio.load(html);
  const urls = $(".single-product-item .img-holder img")
    .map((_, el) => toAbs($(el).attr("src")))
    .get()
    .filter(isImageUrl);
  return uniq(urls);
}

function extractProductLinks(html) {
  const $ = cheerio.load(html);
  const links = $(".single-product-item .img-holder a, .single-product-item .product-title a")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter((href) => /details\/|prod\//i.test(href))
    .map(toAbs);
  return uniq(links);
}

function extractProductImages(html) {
  const $ = cheerio.load(html);
  const urls = new Set();

  $(".img-holder img, .thumb-image img, .thumb-image").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-imagezoom");
    const abs = toAbs(src);
    if (abs && isImageUrl(abs)) urls.add(abs);
  });

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const abs = toAbs(src);
    if (abs && isImageUrl(abs) && /\/images\/produits\//i.test(abs)) urls.add(abs);
  });

  return [...urls];
}

// ==============================
// 🧩 LOGIQUE DE SCRAPING
// ==============================

async function scrapeCategory(categoryName, relativePath) {
  const folder = path.join(OUTPUT_DIR, safeFileName(categoryName));
  await fs.ensureDir(folder);

  const categoryUrl = toAbs(relativePath);
  console.log(`\n==> ${categoryName}\n${categoryUrl}`);

  // Fetch category page
  const catHtml = (await fetchWithRetry(categoryUrl)).data;

  // Extract thumbnails and product links
  const catThumbs = extractCategoryImages(catHtml);
  const productLinks = extractProductLinks(catHtml);

  // Fetch each product page with concurrency limit
  const limitFetch = pLimit(FETCH_CONCURRENCY);
  const productPages = await Promise.all(
    productLinks.map((url) =>
      limitFetch(async () => {
        try {
          const res = await fetchWithRetry(url);
          return res.data;
        } catch (e) {
          console.error("❌ Product fetch failed:", url, e.message);
          return "";
        }
      })
    )
  );

  // Extract all product images
  const allImages = uniq([
    ...catThumbs,
    ...productPages.flatMap((html) => extractProductImages(html))
  ]);

  console.log(
    `📦 ${categoryName}: ${allImages.length} image(s) (${productLinks.length} product(s))`
  );

  // Download all images
  const limitDl = pLimit(DOWNLOAD_CONCURRENCY);
  let index = 1;

  await Promise.all(
    allImages.map((imgUrl) =>
      limitDl(async () => {
        const ext = extFromUrl(imgUrl);
        const urlName = safeFileName(path.basename(imgUrl.split("?")[0]));
        const fileName = urlName.includes(".")
          ? urlName
          : `${safeFileName(categoryName)}_${String(index++).padStart(3, "0")}${ext}`;
        const dest = path.join(folder, fileName);

        if (!(await fs.pathExists(dest))) {
          await downloadFile(imgUrl, dest);
          console.log("⬇️", imgUrl, "->", fileName);
        }
      })
    )
  );
}

// ==============================
// 🚀 MAIN EXECUTION
// ==============================

(async function main() {
  await fs.ensureDir(OUTPUT_DIR);
  console.log("Saving images into:", OUTPUT_DIR);

  for (const [name, rel] of Object.entries(CATEGORIES)) {
    try {
      await scrapeCategory(name, rel);
    } catch (e) {
      console.error(`[ERROR] Category "${name}" failed:`, e.message);
    }
  }

  console.log("\n✅ All done!");
})();
