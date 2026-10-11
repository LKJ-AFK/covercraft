// CoverCraft Zibby build: extract index.html + static pages from the original worker.
// Run: node build/extract.js   (from zibby-port/covercraft/)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, '..', '..', 'cover-letter', 'cover-letter-worker-v2.js');
const OUT_INDEX = path.join(ROOT, 'index.html');
const OUT_PAGES = path.join(ROOT, 'pages');

const src = fs.readFileSync(WORKER, 'utf8');

// ---------- 1) index.html: the HTML template (const HTML = `...`;) ----------
const m = src.match(/const HTML = `([\s\S]*?)`;\r?\nexport/);
if (!m) { console.error('FAIL: HTML template not found'); process.exit(1); }
let indexHtml = m[1];

// swap jspdf CDN -> local vendor (deterministic, works inside the Zibby shell)
indexHtml = indexHtml.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[^"]*\/jspdf\.umd\.min\.js"><\/script>/,
  '<script src="./vendor/jspdf.umd.min.js"></script>'
);

// drop the inline front-end script, replace with the ESM app module
indexHtml = indexHtml.replace(
  /<script>\r?\n\(function\(\)\{\r?\n  'use strict';[\s\S]*?<\/script>\r?\n/,
  '<script type="module" src="./app.js"></script>\n'
);

// paywall bits have no meaning on Zibby — neutralise the buy URL
indexHtml = indexHtml.replace(/__BUY_URL__/g, '#');

// ---------- 2) link rewriting (works for index and pages alike) ----------
function rewriteLinks(html) {
  let h = html;
  h = h.replace(/https:\/\/c1\.ersilabs\.com\//g, './');
  h = h.replace(/<link rel="canonical" href="[^"]*">\r?\n/, '');
  h = h.replace(/href="\/examples\//g, 'href="./pages/');
  h = h.replace(/href="\.\/pages\/([a-z0-9-]+)"/g, 'href="./pages/$1.html"');
  h = h.replace(/href="\/cover-letter-critique"/g, 'href="./pages/cover-letter-critique.html"');
  h = h.replace(/href="\/privacy"/g, 'href="./pages/privacy.html"');
  h = h.replace(/href="\/terms"/g, 'href="./pages/terms.html"');
  h = h.replace(/href="\/acceptable-use"/g, 'href="./pages/acceptable-use.html"');
  h = h.replace(/href="\/about"/g, 'href="./pages/about.html"');
  h = h.replace(/href="\/"/g, 'href="./"');
  return h;
}
indexHtml = rewriteLinks(indexHtml);
fs.writeFileSync(OUT_INDEX, indexHtml);
console.log('index.html written:', indexHtml.length, 'chars');

// ---------- 3) static pages: eval the SEO section and collect constants ----------
const seoStart = src.indexOf('// ==================== SEO content pages');
if (seoStart < 0) { console.error('FAIL: SEO section not found'); process.exit(1); }
const seoSrc = src.slice(seoStart);

const sandbox = { console: console };
try {
  vm.runInNewContext(seoSrc + '\n;globalThis.__pages = { EXAMPLE_DA, EXAMPLE_NOEXP, EXAMPLE_INT, EXAMPLE_TEACHER, EXAMPLE_NURSE, EXAMPLE_CS, EXAMPLE_SWE, EXAMPLE_MKT, EXAMPLE_ACC, EXAMPLE_ADMIN, EXAMPLE_PM, EXAMPLE_SALES, ARTICLE_CRITIQUE, PAGE_PRIVACY, PAGE_TERMS, PAGE_AUP, PAGE_ABOUT };', sandbox, { timeout: 10000 });
} catch (e) {
  console.error('FAIL: SEO eval error:', e.message);
  process.exit(1);
}
const P = sandbox.__pages;
if (!P) { console.error('FAIL: pages object missing'); process.exit(1); }

const pages = [
  ['data-analyst-cover-letter.html', P.EXAMPLE_DA],
  ['no-experience-cover-letter.html', P.EXAMPLE_NOEXP],
  ['internship-cover-letter.html', P.EXAMPLE_INT],
  ['teacher-cover-letter.html', P.EXAMPLE_TEACHER],
  ['nurse-cover-letter.html', P.EXAMPLE_NURSE],
  ['customer-service-cover-letter.html', P.EXAMPLE_CS],
  ['software-engineer-cover-letter.html', P.EXAMPLE_SWE],
  ['marketing-manager-cover-letter.html', P.EXAMPLE_MKT],
  ['accountant-cover-letter.html', P.EXAMPLE_ACC],
  ['administrative-assistant-cover-letter.html', P.EXAMPLE_ADMIN],
  ['project-manager-cover-letter.html', P.EXAMPLE_PM],
  ['sales-representative-cover-letter.html', P.EXAMPLE_SALES],
  ['cover-letter-critique.html', P.ARTICLE_CRITIQUE],
  ['privacy.html', P.PAGE_PRIVACY],
  ['terms.html', P.PAGE_TERMS],
  ['acceptable-use.html', P.PAGE_AUP],
  ['about.html', P.PAGE_ABOUT],
];

if (!fs.existsSync(OUT_PAGES)) fs.mkdirSync(OUT_PAGES, { recursive: true });
let count = 0;
for (const [name, html] of pages) {
  if (typeof html !== 'string' || !html) { console.error('MISSING page:', name); continue; }
  fs.writeFileSync(path.join(OUT_PAGES, name), rewriteLinks(html));
  count++;
}
console.log('pages written:', count, '/', pages.length);
