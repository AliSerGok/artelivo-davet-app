import { config } from "../config.js";

// ============================================================================
// Artelivo sanatçı daveti API'si (apps/web/agent/artist-invites/README.md).
//   ajan anahtarı → taslak yaz / oku / düzenle / sil
//   link anahtarı → yalnız `…/:id/link` (Instagram davetinin sahiplenme linki)
// Anahtar yanlışsa Artelivo gövdesiz 404 döner — burada açık bir hataya çevrilir.
// ============================================================================

export class ArtelivoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: unknown,
  ) {
    super(
      `${status} ${code}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
    );
  }
}

async function call<T>(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!key) throw new ArtelivoError(0, "NO_KEY", "anahtar .env'de yok");
  const res = await fetch(
    `${config.artelivo.apiUrl}/api/agent/artist-invites${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    if (!text && res.status === 404) {
      throw new ArtelivoError(
        404,
        "DOOR_CLOSED",
        "anahtar yanlış ya da uç yayında değil",
      );
    }
    let parsed: { error?: string; detail?: unknown } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // gövde JSON değil
    }
    throw new ArtelivoError(
      res.status,
      parsed.error ?? "HTTP",
      parsed.detail ?? text.slice(0, 300),
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const agent = <T>(method: string, path: string, body?: unknown) =>
  call<T>(config.artelivo.agentKey, method, path, body);

export interface CreateResult {
  id: string;
  reviewUrl: string;
  needsReview: boolean;
  similarProfiles: Array<{ username: string; name: string; match: string }>;
  report: unknown;
}

export interface InviteRecord {
  id: string;
  status: "DRAFT" | "APPROVED" | "INVITED";
  channel: "EMAIL" | "INSTAGRAM";
  name: string;
  instagramUrl: string | null;
  sourceUrl: string;
  reviewUrl: string;
  content?: unknown;
}

export const artelivo = {
  ping: () => agent<{ items: unknown[] }>("GET", ""),
  dryRun: (draft: unknown) =>
    agent<{ ok: boolean; blocks: string[] }>("POST", "?dryRun=1", { draft }),
  create: (draft: unknown) => agent<CreateResult>("POST", "", { draft }),
  get: (id: string) => agent<InviteRecord>("GET", `/${id}`),
  /** Görseli dosya olarak yükler (≤7 MB); dönen `ref` görsel alanına yazılır. */
  upload: (base64: string) =>
    agent<{ ref: string }>("POST", "/uploads", { data: base64 }),
  patch: (id: string, body: unknown) =>
    agent<{ ok: true; reviewUrl: string; report: unknown }>(
      "PATCH",
      `/${id}`,
      body,
    ),
  remove: (id: string) => agent<{ ok: true }>("DELETE", `/${id}`),
  /**
   * Linki alınmış (INVITED) ama DM'i GİTMEMİŞ Instagram davetini geri çeker
   * — YALNIZ link anahtarıyla. Yalnız DM'in gitmediği bilindiğinde çağrılır.
   */
  withdraw: (id: string) =>
    call<{ ok: true }>(config.artelivo.linkKey, "DELETE", `/${id}/link`),
  records: (ids?: string[]) =>
    agent<{ items: InviteRecord[] }>(
      "GET",
      `/records?status=DRAFT,APPROVED,INVITED&limit=500${ids ? "" : ""}`,
    ),
  history: (since: string) =>
    agent<{
      items: Array<{ type: string; at: string; inviteId: string | null }>;
    }>(
      "GET",
      `/history?type=CLAIMED,DECLINED,EXPIRED,WITHDRAWN&since=${encodeURIComponent(since)}&limit=500`,
    ),
  /** Sahiplenme linki — YALNIZ link anahtarıyla. */
  link: (id: string) =>
    call<{ claimUrl: string; expiresAt: string; issued: boolean }>(
      config.artelivo.linkKey,
      "POST",
      `/${id}/link`,
    ),
};
