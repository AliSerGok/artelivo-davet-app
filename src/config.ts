import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

// ============================================================================
// Ayarlar — `.env` (anahtarlar) + `data/` (veritabanı, Chrome profili, yerel gizli)
// ============================================================================

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const DATA_DIR = path.join(ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

/**
 * Taranan adayların "gördük" kaydı yalnız bu anahtarla alınmış özettir
 * (KVKK: aday kişisel verisi saklanmaz). Bir kez üretilir, `data/`'da durur;
 * silinirse "gördük" listesi anlamsızlaşır ve herkes yeniden taranır.
 */
function localHashKey(): string {
  const file = path.join(DATA_DIR, "local-hash-key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const key = randomBytes(32).toString("base64url");
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export const config = {
  port: Number(process.env.PORT || 4317),
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, "davet.sqlite"),
  chromeProfileDir:
    process.env.CHROME_PROFILE_DIR || path.join(DATA_DIR, "chrome-profile"),
  screenshotsDir: path.join(DATA_DIR, "screenshots"),
  hashKey: localHashKey(),
  artelivo: {
    apiUrl: (process.env.ARTELIVO_API_URL || "https://artelivo.com").replace(
      /\/+$/,
      "",
    ),
    /** Taslak yazar/düzenler/siler — link ALAMAZ. */
    agentKey: process.env.ARTIST_INVITE_AGENT_KEY || "",
    /** Yalnız bu masada: Instagram davetinin sahiplenme linki. */
    linkKey: process.env.ARTIST_INVITE_LINK_KEY || "",
  },
  /** Claude Code (Max planı): komut ve model takma adı. */
  claudeBin: process.env.CLAUDE_BIN || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "opus",
  /** Taslak alan kuralları — tek doğruluk kaynağı artemiz deposunda. */
  mappingFile:
    process.env.MAPPING_FILE ||
    path.resolve(ROOT, "../artemiz/apps/web/agent/artist-invites/MAPPING.md"),
} as const;

mkdirSync(config.screenshotsDir, { recursive: true });

/** Eksik anahtarları ayarlar sayfası için söyler; uygulama yine açılır. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.artelivo.agentKey) missing.push("ARTIST_INVITE_AGENT_KEY");
  if (!config.artelivo.linkKey) missing.push("ARTIST_INVITE_LINK_KEY");
  // Claude Code yüklü mü (Max planı ile girişli olmalı: `claude` → /login).
  if (spawnSync(config.claudeBin, ["--version"]).status !== 0) {
    missing.push("Claude Code (claude komutu)");
  }
  if (!existsSync(config.mappingFile)) missing.push("MAPPING_FILE");
  return missing;
}
