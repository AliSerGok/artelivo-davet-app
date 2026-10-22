// Saatchi adaptörünü veritabanına yazmadan dener: `tsx scripts/try-saatchi.ts drawings 3`
import { chromium } from "playwright";

import { saatchi } from "../src/sources/saatchi/index.js";

const [category = "drawings", countArg = "3"] = process.argv.slice(2);
const want = Number(countArg);
const ctx = await chromium.launchPersistentContext("/tmp/davet-try-profile", { channel: "chrome", headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const second = await ctx.newPage();
const found: Array<{ name: string; url: string; works: number | null; city: string | null; ig: string | null }> = [];
await saatchi.collect(page, category, () => true, async (a) => {
  const p = await saatchi.profile(second, a.profileUrl);
  found.push({ name: a.name, url: a.profileUrl, works: p.worksCount, city: p.city, ig: p.instagramHandle });
  return found.length >= want;
});
console.log(JSON.stringify(found, null, 2));
const pick = found.find((f) => (f.works ?? 0) > 0);
if (pick) {
  const all = await saatchi.scrapeAll(page, pick.url);
  console.log(JSON.stringify({ profileText: all.profileText.slice(0, 600), avatar: all.avatarImages, cover: all.coverImages, works: all.works.length, firstWork: all.works[0] && { url: all.works[0].url, text: all.works[0].text.slice(0, 500), images: all.works[0].images } }, null, 2));
}
await ctx.close();
