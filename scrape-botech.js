// scrape-botech.js
// Node 18+ recommended

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";
import sanitize from "sanitize-filename";

const BASE = "https://www.botech.ma/";

// ---------- CONFIG ----------

// Map "Nice Category Name" -> "relative path on site"
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
  "Diagnostique": "prod/diagnostique-maroc"
};

// Where to save everything
const OUT_DIR = path.resolve("botech_images");

// Concurrency limits (be gentle with the site)
const FETCH_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 4;

// Retry policy
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

// ---------- HELPERS ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = axios.create({
  baseURL: BASE,
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; BOTechScraper/1.0; +https://www.example.com/)"
  },
  // follow redirects automatically
  maxRedirects: 5,
  // we’ll handle absolute URLs too
  validateStatus: (s) => s >= 200 && s < 400
});

function toAbs(url) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return new URL(url, BASE).href;
  return BASE + url.replace(/^\.?\//, "");
}

function isImageUrl(u) {
  return /\.(jpe?g|png|webp)$/i.test(u.split("?")[0]);
}

function extFromUrl(u) {
  const clean = u.split("?")[0];
  const m = clean.match(/\.(jpe?g|png|webp)$/i);
  return m ? m[0].toLowerCase() : ".jpg";
}

async function fetchWithRetry(url, opts = {}, attempt = 1) {
  try {
    const res = await client.get(url, opts);
    return res;
  } catch (e) {
    if (attempt >= MAX_RETRIES) throw e;
    await sleep(RETRY_DELAY_MS * attempt);
    return fetchWithRetry(url, opts, attempt + 1);
  }
}

async function downloadFile(url, destPath, attempt = 1) {
  await fs.ensureDir(path.dirname(destPath));
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: { "User-Agent": client.defaults.headers["User-Agent"] }
    });
    await fs.writeFile(destPath, res.data);
  } catch (e) {
    if (attempt >= MAX_RETRIES) {
      console.error("❌ Failed:", url, "->", destPath, e.message);
      return;
    }
    await sleep(RETRY_DELAY_MS * attempt);
    return downloadFile(url, destPath, attempt + 1);
  }
}

function safeFileName(name) {
  return sanitize(name).replace(/\s+/g, "_").slice(0, 150);
}

// Remove dupes while preserving order
function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr) {
    if (!s.has(x)) {
      s.add(x);
      out.push(x);
    }
  }
  return out;
}

// ---------- CORE SCRAPING ----------

async function getCategoryPageImageUrls(html) {
  const $ = cheerio.load(html);
  const urls = [];

  // Card images on category pages
  $(".single-product-item .img-holder img").each((_, el) => {
    const src = $(el).attr("src");
    const abs = toAbs(src);
    if (abs && isImageUrl(abs)) urls.push(abs);
  });

  return uniq(urls);
}

async function getProductLinksFromCategory(html) {
  const $ = cheerio.load(html);
  const links = [];

  // Click-through links on cards (either details/… or prod/… depending on view)
  $(".single-product-item .img-holder a, .single-product-item .product-title a")
    .each((_, el) => {
      const href = $(el).attr("href");
      if (href && /details\/|prod\//i.test(href)) {
        links.push(toAbs(href));
      }
    });

  return uniq(links);
}

async function getProductImages(html) {
  const $ = cheerio.load(html);
  const urls = [];

  // Main product image (from provided snippet)
  $(".img-holder img, .thumb-image img, .thumb-image").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    const dataZoom = $(el).attr("data-imagezoom"); // sometimes main image has data-imagezoom
    const cand = src || dataZoom;
    const abs = toAbs(cand);
    if (abs && isImageUrl(abs)) urls.push(abs);
  });

  // Any other <img> within product page that matches /images/produits/
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const abs = toAbs(src);
    if (abs && isImageUrl(abs) && /\/images\/produits\//i.test(abs)) {
      urls.push(abs);
    }
  });

  return uniq(urls);
}

async function scrapeCategory(categoryName, relativePath) {
  const folder = path.join(OUT_DIR, safeFileName(categoryName));
  await fs.ensureDir(folder);

  const categoryUrl = toAbs(relativePath);
  console.log(`\n==> Category: ${categoryName}\n${categoryUrl}`);

  // 1) Fetch category page
  const catRes = await fetchWithRetry(categoryUrl);
  const catHtml = catRes.data;

  // 2) Collect images visible on category listing page (thumbnails)
  const catThumbs = await getCategoryPageImageUrls(catHtml);

  // 3) Collect product links and crawl each product
  const productLinks = await getProductLinksFromCategory(catHtml);

  // Fetch product pages (limited concurrency)
  const limitFetch = pLimit(FETCH_CONCURRENCY);
  const productPages = await Promise.all(
    productLinks.map((u) =>
      limitFetch(async () => {
        try {
          const res = await fetchWithRetry(u);
          return { url: u, html: res.data };
        } catch (e) {
          console.error("❌ Product fetch failed:", u, e.message);
          return { url: u, html: "" };
        }
      })
    )
  );

  // Extract product images
  const productImgs = [];
  for (const p of productPages) {
    if (!p.html) continue;
    const imgs = await getProductImages(p.html);
    productImgs.push(...imgs);
  }

  const allImages = uniq([...catThumbs, ...productImgs]);

  console.log(
    `Found ${allImages.length} image(s) in "${categoryName}" (${productLinks.length} product page(s))`
  );

  // 4) Download images into the category folder
  const limitDl = pLimit(DOWNLOAD_CONCURRENCY);
  let idx = 1;
  await Promise.all(
    allImages.map((imgUrl) =>
      limitDl(async () => {
        const ext = extFromUrl(imgUrl);
        // try to keep original file name when possible
        const urlName = safeFileName(path.basename(imgUrl.split("?")[0]));
        const fileName =
          urlName && urlName.includes(".")
            ? urlName
            : `${safeFileName(categoryName)}_${String(idx++).padStart(3, "0")}${ext}`;
        const dest = path.join(folder, fileName);
        if (await fs.pathExists(dest)) return; // skip if already downloaded
        await downloadFile(imgUrl, dest);
        console.log("⬇️  ", imgUrl, "->", dest);
      })
    )
  );
}

async function main() {
  await fs.ensureDir(OUT_DIR);
  console.log("Saving into:", OUT_DIR);

  for (const [name, rel] of Object.entries(CATEGORIES)) {
    try {
      await scrapeCategory(name, rel);
    } catch (e) {
      console.error(`\n[ERROR] Category "${name}" failed:`, e.message);
    }
  }

  console.log("\n✅ Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
