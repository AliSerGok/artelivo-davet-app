// Kapanan davetin yerel kaydı siliniyor mu: yerel Artelivo'da taslak aç → yerele bağla →
// Artelivo'da sil → eşitle → kayıt gitmiş, yalnız sayaç ve özet kalmış olmalı.
import { artelivo } from "../src/artelivo/client.js";
import { db } from "../src/db/index.js";
import { closedCounts, syncWithArtelivo } from "../src/jobs/handlers.js";

const src = "https://www.saatchiart.com/account/profile/888888888";
const created = await artelivo.create({
  name: "Deneme Kapanış",
  sourceUrl: src,
  instagramUrl: "https://www.instagram.com/artelivo_kapanis_test/",
});
const row = db
  .prepare("INSERT INTO artists (source, name, source_url, instagram_url, stage, invite_id) VALUES ('saatchi','Deneme Kapanış',?, 'https://www.instagram.com/artelivo_kapanis_test/','drafted',?)")
  .run(src, created.id);
const id = Number(row.lastInsertRowid);
db.prepare("INSERT INTO dm_messages (artist_id, text) VALUES (?, 'deneme {LINK}')").run(id);
await artelivo.remove(created.id);
const before = closedCounts().withdrawn ?? 0;
await syncWithArtelivo();
const gone = !db.prepare("SELECT 1 FROM artists WHERE id = ?").get(id);
const dmGone = !db.prepare("SELECT 1 FROM dm_messages WHERE artist_id = ?").get(id);
const seen = db.prepare("SELECT outcome FROM seen WHERE outcome = 'invite_withdrawn'").get() as { outcome: string } | undefined;
console.log({ artistDeleted: gone, dmDeleted: dmGone, seen: seen?.outcome, counted: (closedCounts().withdrawn ?? 0) === before + 1 });
db.prepare("DELETE FROM seen WHERE outcome = 'invite_withdrawn'").run();
db.prepare("DELETE FROM events WHERE kind = 'invite_closed'").run();
