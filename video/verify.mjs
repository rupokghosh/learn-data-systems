// Plays the finished MP4s in Chrome to confirm they decode. Writes a contact sheet of frames
// (out/verify.jpg) and a 1:1 crop from the middle of a camera move (out/verify-crop.png).
import puppeteer from "puppeteer-core";
const TIMES = [0.5, 2.9, 4.3, 5.2, 7.2, 9.4, 11.0, 13.2, 15.9];
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto("http://localhost:4321/video/encode.html");
await page.addStyleTag({ content: "body{margin:0;background:#000;display:grid;grid-template-columns:repeat(3,640px)}canvas{display:block}" });
const load = (file) => page.evaluate(async (file) => {
  // Load the whole file into memory first: the simple Python server cannot serve byte ranges for seeking.
  const blob = await (await fetch("/video/out/" + file)).blob();
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error(file + " failed to load")); });
  window.__vid = v;
  return { file, duration: +v.duration.toFixed(2), width: v.videoWidth, height: v.videoHeight, megabytes: +(blob.size / 1e6).toFixed(1) };
}, file);
const seek = (t) => page.evaluate((t) => new Promise((r) => { __vid.onseeked = r; __vid.currentTime = t; }), t);

console.log(JSON.stringify(await load("trailer-4k.mp4")));
await seek(8.0);
console.log(JSON.stringify(await load("trailer.mp4")));
for (const t of TIMES) {
  await seek(t);
  await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 640; c.height = 360; c.getContext("2d").drawImage(__vid, 0, 0, 640, 360); document.body.appendChild(c); });
}
await page.screenshot({ path: "out/verify.jpg", type: "jpeg", quality: 82 });
// 1:1 crop of the 1080p file while the camera is moving in on the B-tree.
await seek(5.0);
await page.evaluate(() => { document.body.innerHTML = ""; const c = document.createElement("canvas"); c.width = 1200; c.height = 640; c.getContext("2d").drawImage(__vid, 360, 220, 1200, 640, 0, 0, 1200, 640); document.body.appendChild(c); });
await page.screenshot({ path: "out/verify-crop.png", clip: { x: 0, y: 0, width: 1200, height: 640 } });
await browser.close();
