// Tek bir profili tam tarar: `tsx scripts/try-saatchi-one.ts <profil adresi>`
import { chromium } from "playwright";

import { saatchi } from "../src/sources/saatchi/index.js";

const url = process.argv[2] ?? "https://www.saatchiart.com/account/profile/2759525";
const ctx = await chromium.launchPersistentContext("/tmp/davet-try-profile", { channel: "chrome", headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const all = await saatchi.scrapeAll(page, url);
console.log(JSON.stringify({ ...all, works: all.works.slice(0, 2), workCount: all.works.length }, null, 2));
await ctx.close();
