import { saatchi } from "./saatchi/index.js";
import type { SourceAdapter } from "./types.js";

/** Taranabilecek siteler. Yenisi = bir adaptör + buraya bir satır. */
export const SOURCES: Record<string, SourceAdapter> = {
  [saatchi.id]: saatchi,
};

export function sourceOf(id: string): SourceAdapter {
  const source = SOURCES[id];
  if (!source) throw new Error(`Bilinmeyen kaynak: ${id}`);
  return source;
}
