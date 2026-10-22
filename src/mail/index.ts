import nodemailer from "nodemailer";

import { config } from "../config.js";

// ============================================================================
// Davet e-postası (kullanıcı, 2026-10-23): artemiz'in SMTP'si, info@artelivo.com.
// Metin DM'in aynısı (kişiye özel, link içinde); konu dile göre.
// ============================================================================

export const smtpReady = () =>
  Boolean(config.smtp.host && config.smtp.user && config.smtp.password);

function transport() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });
}

/** "Bağlantıları dene": sunucuya bağlanıp giriş yapar, mail göndermez. */
export async function verifySmtp(): Promise<void> {
  if (!smtpReady()) throw new Error("SMTP_* .env'de yok");
  await transport().verify();
}

const SUBJECT = {
  tr: "Artelivo'da sizin için bir profil hazırladık",
  en: "We've prepared an Artelivo profile for you",
} as const;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Düz metin → sade HTML: paragraflar, satır sonları, tıklanır linkler. */
function toHtml(text: string): string {
  const body = text
    .trim()
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 14px">${escape(p)
          .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f1f1f;max-width:560px">${body}</div>`;
}

export async function sendInviteEmail(to: string, text: string, lang: "tr" | "en"): Promise<void> {
  await transport().sendMail({
    from: `${config.smtp.fromName.replace(/[\r\n<>"]/g, " ").trim() || "Artelivo"} <${config.smtp.user}>`,
    to,
    subject: SUBJECT[lang],
    text,
    html: toHtml(text),
  });
}
