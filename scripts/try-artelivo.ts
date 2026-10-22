// Artelivo istemcisini dener (yerelde): taslak oluştur → oku → link (anahtar yoksa kapalı) → sil.
import { ArtelivoError, artelivo } from "../src/artelivo/client.js";

const draft = {
  name: "Deneme Davet Masası",
  sourceUrl: "https://www.saatchiart.com/account/profile/2759525",
  sourceNote: "Instagram hesabı adla arandı, yönetici doğruladı.",
  instagramUrl: "https://www.instagram.com/artelivo_davet_masasi_test/",
  country: "TR",
  city: "İstanbul",
  content: {
    works: [
      {
        kind: "ARTWORK",
        title: "COLORPHYSICAL EXPERIENCES",
        year: 2025,
        mediumText: "Seramik modelleme",
        width: 30, height: 60, depth: 20,
        dimensionsText: "11.8 W x 23.6 H x 7.9 D in",
        imageUrls: ["https://images.saatchiart.com/saatchi/2759525/art/12767189/11829367-BTGJAPKD-8.jpg"],
      },
    ],
  },
};
console.log("ping", (await artelivo.ping()).items.length, "taslak listede");
console.log("dryRun", await artelivo.dryRun(draft));
const created = await artelivo.create(draft);
console.log("create", created.id, created.reviewUrl, JSON.stringify(created.report));
const record = await artelivo.get(created.id);
console.log("get", record.status, record.channel, record.instagramUrl);
try {
  await artelivo.link(created.id);
  console.log("link: beklenmedik başarı");
} catch (e) {
  console.log("link:", e instanceof ArtelivoError ? `${e.status} ${e.code}` : e);
}
console.log("delete", await artelivo.remove(created.id));
