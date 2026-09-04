/**
 * 시안을 PDF·PNG 로 굽는다 — NERV 첨부용.
 *
 *   npx puppeteer                       (한 번만)
 *   node design/render.mjs design/ui-mockup.html out.pdf out.png dark
 *
 * 마지막 인자는 테마다(light·dark, 비우면 시스템). 첨부가 필요 없으면 브라우저로
 * ui-mockup.html 을 그냥 열면 된다 — 의존성 없는 한 장짜리 파일이다.
 */
import puppeteer from 'puppeteer';
const [,, src, outPdf, outPng, theme] = process.argv;
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 1200, deviceScaleFactor: 2 });
await p.goto('file://' + src, { waitUntil: 'networkidle0' });
if (theme) await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
await new Promise((r) => setTimeout(r, 1200));
if (outPng) await p.screenshot({ path: outPng, fullPage: true });
if (outPdf) await p.pdf({ path: outPdf, width: '1280px', printBackground: true, preferCSSPageSize: false });
await b.close();
console.log('완료', outPdf || outPng);
