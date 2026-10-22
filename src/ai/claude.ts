import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { config, DATA_DIR } from "../config.js";
import { db } from "../db/index.js";

// ============================================================================
// Claude — bu Mac'teki Claude Code üzerinden (`claude -p`), Max planından.
// ----------------------------------------------------------------------------
// Kullanıcı kararı (2026-10-19): ek ücret yok, API anahtarı kullanılmaz.
//   • ANTHROPIC_API_KEY alt sürece HİÇ verilmez: verilseydi Claude Code onu
//     kullanır ve ayrı faturaya yazardı. Oturum `claude` girişindeki hesaptır.
//   • Araç yok (`--tools ""`): yalnız metin üretir; dosya, komut, web yok.
//   • Boş bir çalışma klasöründe, ayar/MCP/oturum kaydı yüklenmeden çalışır.
// ============================================================================

const WORK_DIR = path.join(DATA_DIR, "claude-cwd");
mkdirSync(WORK_DIR, { recursive: true });

type Effort = "low" | "medium" | "high";

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

function runClaude(input: {
  prompt: string;
  system: string;
  effort: Effort;
  schema?: unknown;
  timeoutMs?: number;
}): Promise<ClaudeResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    config.claudeModel,
    "--effort",
    input.effort,
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--system-prompt",
    input.system,
  ];
  if (input.schema) args.push("--json-schema", JSON.stringify(input.schema));

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: WORK_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("Claude Code zaman aşımı"));
      },
      input.timeoutMs ?? 15 * 60 * 1000,
    );
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Claude Code çalıştırılamadı (${config.claudeBin}): ${e.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as ClaudeResult;
        if (parsed.is_error) {
          reject(new Error(`Claude Code hata döndü: ${parsed.result ?? err}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(
          new Error(
            `Claude Code çıktısı okunamadı (çıkış ${code}): ${(err || out).slice(0, 400)}`,
          ),
        );
      }
    });
    // Uzun metin (taslak kaynakları) komut satırına değil, girdiye yazılır.
    child.stdin.end(input.prompt);
  });
}

function recordUsage(purpose: string, result: ClaudeResult): void {
  let input = 0;
  let output = 0;
  for (const m of Object.values(result.modelUsage ?? {})) {
    // Claude Code istemin çoğunu önbellekten okur; girdi = hepsinin toplamı.
    input +=
      (m.inputTokens ?? 0) +
      (m.cacheReadInputTokens ?? 0) +
      (m.cacheCreationInputTokens ?? 0);
    output += m.outputTokens ?? 0;
  }
  db.prepare(
    "INSERT INTO usage (purpose, input_tokens, output_tokens) VALUES (?, ?, ?)",
  ).run(purpose, input, output);
}

/** Şemaya uyan JSON döndüren tek çağrı. */
export async function askJson<S extends z.ZodType>(input: {
  purpose: string;
  schema: S;
  system: string;
  user: string;
  effort: Effort;
}): Promise<z.output<S>> {
  const result = await runClaude({
    prompt: input.user,
    system: input.system,
    effort: input.effort,
    // Claude Code `$schema` (draft 2020-12) anahtarını tanımıyor: çıkar.
    schema: (({ $schema: _drop, ...rest }) => rest)(
      z.toJSONSchema(input.schema) as Record<string, unknown>,
    ),
  });
  recordUsage(input.purpose, result);
  const parsed = input.schema.safeParse(result.structured_output);
  if (!parsed.success) {
    throw new Error(
      `Claude'un cevabı şemaya uymadı (${input.purpose}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Serbest JSON (şeması Artelivo'da duran taslak gibi) — metinden ayıklanır. */
export async function askFreeJson(input: {
  purpose: string;
  system: string;
  prompt: string;
  effort: Effort;
}): Promise<{ json: unknown; raw: string }> {
  const result = await runClaude({
    prompt: input.prompt,
    system: input.system,
    effort: input.effort,
  });
  recordUsage(input.purpose, result);
  const raw = result.result ?? "";
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  const candidate =
    fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return { json: JSON.parse(candidate), raw };
}

/** Ayarlar sayfası için toplam kullanım (Max planından; bilgi amaçlı). */
export function usageSummary(): Array<{
  purpose: string;
  calls: number;
  input: number;
  output: number;
}> {
  return db
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output
       FROM usage GROUP BY purpose ORDER BY purpose`,
    )
    .all() as Array<{
    purpose: string;
    calls: number;
    input: number;
    output: number;
  }>;
}
