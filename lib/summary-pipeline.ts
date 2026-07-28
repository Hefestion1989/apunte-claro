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

export type SummaryLength = "short" | "medium" | "long";

export function buildLocalSummaryPlan(totalWords: number, requestedLength: SummaryLength) {
  const optimized = totalWords >= 30_000;
  const preference =
    requestedLength === "short"
      ? "speed"
      : optimized || requestedLength === "medium"
        ? "auto"
        : "capability";

  return {
    optimized,
    chunkChars: optimized ? 24_000 : 16_000,
    preference: preference as "speed" | "auto" | "capability",
    sectionType: optimized ? ("key-points" as const) : ("tldr" as const),
    sectionFormat: optimized ? ("markdown" as const) : ("plain-text" as const),
    sectionLength: optimized
      ? requestedLength === "short"
        ? ("short" as const)
        : ("medium" as const)
      : ("long" as const),
    finalLength: optimized ? ("medium" as const) : requestedLength,
    retryIncomplete: !optimized,
    includeIntegratedKeyPoints: !optimized,
  };
}

export function buildIntegrationSource(partials: string[], sentencesPerSection = 2) {
  const safeLimit = Math.max(1, Math.floor(sentencesPerSection));
  return partials
    .map((partial) => {
      const sentences = partial
        .replace(/^[-*]\s+/gm, "")
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
      return sentences.slice(0, safeLimit).join(" ");
    })
    .filter(Boolean)
    .join("\n\n");
}

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

const RTF_DESTINATIONS = new Set([
  "colortbl",
  "datastore",
  "field",
  "filetbl",
  "fldinst",
  "fonttbl",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "generator",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "info",
  "listoverridetable",
  "listtable",
  "object",
  "pict",
  "pntext",
  "stylesheet",
  "themedata",
  "xmlnstbl",
]);

const WINDOWS_1252_SPECIALS: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeWindows1252Byte(byte: number) {
  return WINDOWS_1252_SPECIALS[byte] ?? String.fromCharCode(byte);
}

export function extractRtfText(rtf: string) {
  if (!/^\s*\{\\rtf/i.test(rtf)) return rtf;

  type RtfState = { ignorable: boolean; unicodeFallbackLength: number };
  const states: RtfState[] = [{ ignorable: false, unicodeFallbackLength: 1 }];
  let state = states[0];
  let output = "";
  let index = 0;
  let fallbackCharactersToSkip = 0;

  const emitVisible = (value: string) => {
    if (state.ignorable) return;
    if (fallbackCharactersToSkip > 0) {
      fallbackCharactersToSkip -= 1;
      return;
    }
    output += value;
  };

  const emitControlText = (value: string) => {
    if (!state.ignorable) output += value;
  };

  while (index < rtf.length) {
    const character = rtf[index];

    if (character === "{") {
      state = { ...state };
      states.push(state);
      index += 1;
      continue;
    }

    if (character === "}") {
      if (states.length > 1) states.pop();
      state = states.at(-1)!;
      index += 1;
      continue;
    }

    if (character !== "\\") {
      emitVisible(character);
      index += 1;
      continue;
    }

    index += 1;
    if (index >= rtf.length) break;
    const symbol = rtf[index];

    if (symbol === "\\" || symbol === "{" || symbol === "}") {
      emitVisible(symbol);
      index += 1;
      continue;
    }

    if (symbol === "'" && /^[0-9a-f]{2}$/i.test(rtf.slice(index + 1, index + 3))) {
      emitVisible(decodeWindows1252Byte(Number.parseInt(rtf.slice(index + 1, index + 3), 16)));
      index += 3;
      continue;
    }

    if (symbol === "*") {
      state.ignorable = true;
      index += 1;
      continue;
    }

    if (!/[a-z]/i.test(symbol)) {
      const symbolMap: Record<string, string> = {
        "~": " ",
        "_": "‑",
        "-": "",
      };
      if (symbol in symbolMap) emitVisible(symbolMap[symbol]);
      index += 1;
      continue;
    }

    const wordStart = index;
    while (/[a-z]/i.test(rtf[index] ?? "")) index += 1;
    const controlWord = rtf.slice(wordStart, index).toLowerCase();
    const numberStart = index;
    if (rtf[index] === "-") index += 1;
    while (/\d/.test(rtf[index] ?? "")) index += 1;
    const rawParameter = rtf.slice(numberStart, index);
    const parameter = rawParameter ? Number.parseInt(rawParameter, 10) : null;
    if (rtf[index] === " ") index += 1;

    if (RTF_DESTINATIONS.has(controlWord)) {
      state.ignorable = true;
      continue;
    }
    if (controlWord === "uc" && parameter !== null) {
      state.unicodeFallbackLength = Math.max(0, parameter);
      continue;
    }
    if (state.ignorable) continue;

    if (controlWord === "u" && parameter !== null) {
      const codePoint = parameter < 0 ? parameter + 65_536 : parameter;
      emitControlText(String.fromCodePoint(codePoint));
      fallbackCharactersToSkip = state.unicodeFallbackLength;
      continue;
    }

    const controlText: Record<string, string> = {
      bullet: "•",
      emdash: "—",
      endash: "–",
      line: "\n",
      lquote: "‘",
      par: "\n",
      rquote: "’",
      tab: "\t",
    };
    if (controlWord in controlText) emitControlText(controlText[controlWord]);
  }

  return output
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

export function analyzeExternalMaterial(material: string) {
  const sourceNames = [
    ...material.matchAll(/===== FUENTE:\s*(.+?)\s*=====/gi),
  ].map((match) => match[1].trim());
  const hasPastedText = /===== TEXTO PEGADO =====/i.test(material);
  const pages = [...material.matchAll(/\[Página\s+(\d+)\]/gi)];
  const words = material.trim() ? material.trim().split(/\s+/).length : 0;
  const parts = splitByStructure(material, 120_000, 0);
  const assessmentEvidence =
    sourceNames.some((name) =>
      /\b(?:examen|parcial|programa|gu[ií]a|consigna|evaluaci[oó]n)\b/i.test(name),
    ) ||
    /\b(?:preguntas? de (?:examen|parcial)|consignas? de (?:examen|parcial)|programa de la materia|criterios? de evaluaci[oó]n)\b/i.test(
      material,
    );

  return {
    sourceNames,
    sourceCount: sourceNames.length + (hasPastedText ? 1 : 0),
    pageCount: pages.length,
    wordCount: words,
    partCount: Math.max(1, parts.length),
    shouldSplit: material.length > 180_000 || words > 30_000,
    assessmentEvidence,
  };
}

export function buildExternalPartPackage(
  destination: string,
  prompt: string,
  material: string,
  partNumber: number,
  totalParts: number,
) {
  return `# Paquete de estudio para ${destination} · parte ${partNumber} de ${totalParts}

## Cómo trabajar esta parte

- Aplicá la instrucción académica al material incluido debajo.
- Prepará una síntesis parcial y conservá autores, conceptos, fuentes y páginas.
- No presentes todavía una conclusión general del curso.
- Guardá la respuesta: al terminar todas las partes se integrarán sin mezclar atribuciones.

## Instrucción académica

${prompt}

---

## Material de esta parte

${material}
`;
}

export function buildExternalIntegrationPrompt(destination: string, totalParts: number) {
  return `# Integración final para ${destination}

Ya se procesaron ${totalParts} partes del material por separado. Pegá debajo las síntesis parciales y elaborá una guía de estudio final.

REQUISITOS
- Integrá conceptos y relaciones sin borrar diferencias entre autores o fuentes.
- Eliminá repeticiones, pero conservá excepciones, críticas y contradicciones.
- Mantené las referencias de archivo, página o sección presentes en las síntesis.
- No agregues conocimiento externo.
- Si dos síntesis se contradicen, marcá [Requiere revisión] y explicá la diferencia.
- Cerrá con conceptos clave, relaciones importantes, datos a memorizar y 5 preguntas de autoevaluación.

SÍNTESIS PARCIALES
[Pegá aquí las respuestas obtenidas para las ${totalParts} partes]
`;
}
