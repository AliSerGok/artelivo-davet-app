// Kesilen create sonrası: Artelivo'da taslak var, yerelde invite_id yok → bulup bağlamalı.
import { artelivo } from "../src/artelivo/client.js";
import { db } from "../src/db/index.js";
import { type Artist, adoptExistingDraft } from "../src/jobs/handlers.js";

const src = "https://www.saatchiart.com/account/profile/777777777";
const created = await artelivo.create({ name: "Deneme Sahipsiz", sourceUrl: src, instagramUrl: "https://www.instagram.com/artelivo_sahipsiz_test/" });
const row = db.prepare("INSERT INTO artists (source, name, source_url, instagram_url, stage) VALUES ('saatchi','Deneme Sahipsiz',?,'https://www.instagram.com/artelivo_sahipsiz_test/','draft_failed')").run(src);
const id = Number(row.lastInsertRowid);
const artist = db.prepare("SELECT * FROM artists WHERE id = ?").get(id) as Artist;
const adopted = await adoptExistingDraft(artist);
const after = db.prepare("SELECT stage, invite_id FROM artists WHERE id = ?").get(id) as { stage: string; invite_id: string };
console.log(JSON.stringify({ adopted, stage: after.stage, linked: after.invite_id === created.id }));
await artelivo.remove(created.id);
db.prepare("DELETE FROM artists WHERE id = ?").run(id);
db.prepare("DELETE FROM events WHERE kind = 'draft_adopted'").run();
