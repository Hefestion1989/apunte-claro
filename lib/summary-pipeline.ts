export type SectionProgress = {
  completed: number;
  total: number;
  partials: string[];
};

type RunSectionOptions = {
  chunks: string[];
  summarize: (chunk: string, index: number) => Promise<string>;
  recover?: (error: unknown, chunk: string, index: number) => Promise<string> | string;
  onProgress?: (progress: SectionProgress) => void;
  signal?: AbortSignal;
};

export class SummaryCancelled extends Error {
  partials: string[];
  total: number;

  constructor(partials: string[], total: number) {
    super("La generación fue cancelada.");
    this.name = "SummaryCancelled";
    this.partials = partials;
    this.total = total;
  }
}

export function isIncompleteSummary(text: string) {
  const ending = text.trim().replace(/[*_`>#)\]]+$/g, "").trim();
  if (!ending) return true;
  return /(?:\.{3}|…|\b(?:que|de|del|y|o|con|por|para|en|los|las|un|una))$/i.test(ending);
}

export function buildSectionLabels(chunks: string[]) {
  let currentSource = "";

  return chunks.map((chunk, index) => {
    const sourceMatches = [
      ...chunk.matchAll(/===== FUENTE:\s*(.+?)\s*=====/gi),
    ];
    const latestSource = sourceMatches.at(-1)?.[1]?.trim();
    if (latestSource) currentSource = latestSource;

    const pages = [
      ...chunk.matchAll(/\[Página\s+(\d+)\]/gi),
    ].map((match) => Number(match[1])).filter(Number.isFinite);
    const uniquePages = [...new Set(pages)].sort((a, b) => a - b);
    const pageLabel = uniquePages.length
      ? uniquePages.length === 1
        ? `página ${uniquePages[0]}`
        : `páginas ${uniquePages[0]}–${uniquePages.at(-1)}`
      : "";
    const details = [currentSource, pageLabel].filter(Boolean);

    return details.length ? details.join(" · ") : `Sección ${index + 1}`;
  });
}

function throwIfCancelled(signal: AbortSignal | undefined, partials: string[], total: number) {
  if (signal?.aborted) throw new SummaryCancelled([...partials], total);
}

function splitOversizedBlock(block: string, maxChars: number) {
  if (block.length <= maxChars) return [block];
  const sentences = block.split(/(?<=[.!?])\s+/).filter(Boolean);
  const pieces: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      pushCurrent();
      for (let start = 0; start < sentence.length; start += maxChars) {
        pieces.push(sentence.slice(start, start + maxChars).trim());
      }
      continue;
    }
    if (`${current} ${sentence}`.trim().length > maxChars) pushCurrent();
    current = `${current} ${sentence}`.trim();
  }
  pushCurrent();
  return pieces.filter(Boolean);
}

export function splitByStructure(text: string, maxChars = 16_000, overlap = 240) {
  if (!text.trim()) return [];
  const safeMax = Math.max(1, Math.floor(maxChars));
  const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(safeMax / 5));
  const blocks = text
    .split(/\n{2,}|(?=\n(?:#{1,4}\s|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,}\n))/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => splitOversizedBlock(part, safeMax));
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    const candidate = `${current}${current ? "\n\n" : ""}${block}`.trim();
    if (candidate.length <= safeMax) {
      current = candidate;
      continue;
    }

    const finished = current.trim();
    chunks.push(finished);
    const separatorLength = 2;
    const availableOverlap = Math.max(0, safeMax - block.length - separatorLength);
    const carryLength = Math.min(safeOverlap, availableOverlap);
    const carry = carryLength ? finished.slice(-carryLength) : "";
    current = `${carry}${carry ? "\n\n" : ""}${block}`.trim();
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function fitChunksToQuota(
  chunks: string[],
  measure: (chunk: string) => Promise<number>,
  quota: number,
  signal?: AbortSignal,
) {
  const queue = [...chunks];
  const fitted: string[] = [];

  while (queue.length) {
    throwIfCancelled(signal, [], chunks.length);
    const chunk = queue.shift()!;
    if ((await measure(chunk)) <= quota) {
      fitted.push(chunk);
      continue;
    }
    if (chunk.length <= 1) {
      throw new Error("La cuota disponible es demasiado pequeña para procesar el material.");
    }
    const halves = splitByStructure(chunk, Math.max(1, Math.floor(chunk.length / 2)), 0);
    if (halves.length < 2) {
      fitted.push(chunk);
    } else {
      queue.unshift(...halves);
    }
  }
  return fitted;
}

export async function runSectionSummaries({
  chunks,
  summarize,
  recover,
  onProgress,
  signal,
}: RunSectionOptions) {
  const partials: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    throwIfCancelled(signal, partials, chunks.length);
    let partial: string;
    try {
      partial = await summarize(chunks[index], index);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new SummaryCancelled([...partials], chunks.length);
      }
      if (!recover) throw error;
      partial = await recover(error, chunks[index], index);
    }
    partials.push(partial.trim());
    onProgress?.({
      completed: partials.length,
      total: chunks.length,
      partials: [...partials],
    });
  }
  return partials;
}

export function buildPartialSummary(
  partials: string[],
  total: number,
  title: string,
  status: "working" | "cancelled" | "error" = "working",
  labels: string[] = [],
) {
  const completed = partials.length;
  const statusCopy =
    status === "working"
      ? `Borrador en progreso: ${completed} de ${total} secciones procesadas. Podés leerlo mientras continúa.`
      : status === "cancelled"
        ? `Resumen detenido: se conservaron ${completed} de ${total} secciones.`
        : `La generación se interrumpió, pero se conservaron ${completed} de ${total} secciones.`;

  return `# ${title || "Resumen de estudio"} · borrador parcial

> ${statusCopy}

## Síntesis recuperada por secciones

${partials.map((partial, index) => `### ${labels[index] || `Sección ${index + 1}`}\n\n${partial}`).join("\n\n")}

## Estado

Este borrador todavía no pasó por la integración final. Verificá nombres, fechas y relaciones contra el material original.`;
}

export function buildExternalPackage(destination: string, prompt: string, material: string) {
  return `# Paquete de estudio para ${destination}

## Instrucción

${prompt}

---

## Material de estudio

${material}
`;
}
