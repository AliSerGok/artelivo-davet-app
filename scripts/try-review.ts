// Bölünmüş ekranı bir deneme adayıyla açar, sol pencerenin ekran görüntüsünü alır, kapatır, siler.
import { db } from "../src/db/index.js";
import { browser } from "../src/lib/browser.js";
import { startReview, stopReview } from "../src/review/index.js";

const run = db.prepare("INSERT INTO runs (source, category, target, status) VALUES ('saatchi','drawings',1,'ready')").run();
const runId = Number(run.lastInsertRowid);
const cand = db.prepare(
  "INSERT INTO candidates (run_id, source, name, source_url, city, works_count, status) VALUES (?, 'saatchi', 'Yasin Atayilmaz', 'https://www.saatchiart.com/account/profile/2759525', 'İstanbul', 13, 'ready')"
).run(runId);
const cid = Number(cand.lastInsertRowid);
db.prepare("INSERT INTO ig_candidates (candidate_id, handle, score, reason, from_source) VALUES (?, 'saatchiart', 40, 'deneme: <b>etiket</b> metin olarak görünmeli', 0)").run(cid);
db.prepare("INSERT INTO ig_candidates (candidate_id, handle, score, reason, from_source) VALUES (?, 'artelivo', 20, 'ikinci aday', 0)").run(cid);

await startReview(runId);
await new Promise((r) => setTimeout(r, 6000));
const ctx = await browser();
const saatchiPage = ctx.pages().find((p) => p.url().includes("saatchiart.com/"));
if (saatchiPage) {
  await saatchiPage.screenshot({ path: "data/screenshots/review-try.png" });
  const panel = await saatchiPage.locator("#davet-panel").innerText().catch(() => "PANEL YOK");
  console.log("panel:", panel.replace(/\n+/g, " | "));
  const bounds = await Promise.all(ctx.pages().map(async (p) => ({ url: p.url().slice(0, 50), size: await p.evaluate(() => [window.screenX, window.screenY, window.outerWidth, window.outerHeight]) })));
  console.log(JSON.stringify(bounds));
}
// Düğme → bağlama → karar: Reddet'e bas.
if (saatchiPage) {
  await saatchiPage.locator("#davet-reject").click();
  await new Promise((r) => setTimeout(r, 2500));
  const left = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE id = ?").get(cid) as { n: number };
  const seen = db.prepare("SELECT outcome FROM seen WHERE outcome = 'rejected' ORDER BY at DESC LIMIT 1").get() as { outcome: string } | undefined;
  console.log("reject → aday silindi:", left.n === 0, "· seen:", seen?.outcome, "· ad seen'de yok:", !JSON.stringify(db.prepare("SELECT * FROM seen").all()).includes("Atayilmaz"));
}
await stopReview();
db.prepare("DELETE FROM seen WHERE outcome = 'rejected'").run();
db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
await ctx.close();
