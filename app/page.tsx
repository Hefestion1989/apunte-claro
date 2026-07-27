"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Material = {
  id: string;
  name: string;
  size: number;
  text: string;
  status: "ready" | "error";
  note?: string;
};

type EngineState =
  | "checking"
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

type StudyConfig = {
  subject: string;
  topic: string;
  purpose: "comprender" | "examen" | "repaso" | "exposicion";
  level: "introductorio" | "intermedio" | "avanzado";
  format: "guia" | "ficha" | "narrativo" | "comparativo";
  length: "short" | "medium" | "long";
  focus: string[];
  notes: string;
};

const MAX_FILE_BYTES = 18 * 1024 * 1024;
const MAX_TOTAL_CHARS = 280_000;

const PURPOSE_LABELS: Record<StudyConfig["purpose"], string> = {
  comprender: "Comprender desde cero",
  examen: "Preparar un examen",
  repaso: "Repasar rápido",
  exposicion: "Preparar una exposición",
};

const FORMAT_LABELS: Record<StudyConfig["format"], string> = {
  guia: "Guía por secciones",
  ficha: "Ficha de estudio",
  narrativo: "Resumen narrativo",
  comparativo: "Comparar autores o teorías",
};

const LENGTH_LABELS: Record<StudyConfig["length"], string> = {
  short: "Breve",
  medium: "Equilibrado",
  long: "Profundo",
};

const FOCUS_OPTIONS = [
  "Conceptos",
  "Autores",
  "Teorías",
  "Definiciones",
  "Relaciones",
  "Ejemplos",
  "Fechas",
  "Críticas",
];

const SPANISH_STOPWORDS = new Set(
  [
    "para",
    "como",
    "pero",
    "porque",
    "desde",
    "hasta",
    "sobre",
    "entre",
    "también",
    "cuando",
    "donde",
    "este",
    "esta",
    "estos",
    "estas",
    "esto",
    "ese",
    "esa",
    "esos",
    "esas",
    "aquel",
    "aquella",
    "unos",
    "unas",
    "todo",
    "toda",
    "todos",
    "todas",
    "otro",
    "otra",
    "otros",
    "otras",
    "mismo",
    "misma",
    "muy",
    "más",
    "menos",
    "cada",
    "parte",
    "puede",
    "pueden",
    "debe",
    "deben",
    "tiene",
    "tienen",
    "hacer",
    "hecho",
    "sido",
    "son",
    "con",
    "sin",
    "por",
    "del",
    "las",
    "los",
    "una",
    "uno",
    "que",
    "sus",
    "han",
    "hay",
    "fue",
    "ser",
    "sea",
    "al",
    "se",
    "en",
    "es",
    "un",
    "y",
    "o",
    "a",
    "e",
    "u",
    "la",
    "el",
    "lo",
    "de",
  ].map((word) => word.normalize("NFD").replace(/\p{Diacritic}/gu, "")),
);

const initialConfig: StudyConfig = {
  subject: "Psicología",
  topic: "",
  purpose: "comprender",
  level: "intermedio",
  format: "guia",
  length: "medium",
  focus: ["Conceptos", "Autores", "Teorías", "Relaciones"],
  notes: "",
};

function cleanText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function wordCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function splitByStructure(text: string, maxChars = 7_500, overlap = 450) {
  const sections = text
    .split(/\n{2,}|(?=\n(?:#{1,4}\s|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,}\n))/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = current.slice(Math.max(0, current.length - overlap));
  };

  for (const section of sections) {
    if (section.length > maxChars) {
      const sentences = section.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if ((current + "\n" + sentence).length > maxChars) pushCurrent();
        current = `${current}\n${sentence}`.trim();
      }
      continue;
    }
    if ((current + "\n\n" + section).length > maxChars) pushCurrent();
    current = `${current}\n\n${section}`.trim();
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function extractTerms(text: string, limit = 10) {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .match(/[a-zñ]{4,}/g);
  if (!words) return [];
  const counts = new Map<string, number>();
  for (const word of words) {
    if (!SPANISH_STOPWORDS.has(word)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function buildStudyContext(config: StudyConfig, files: string[]) {
  const focus = config.focus.length
    ? config.focus.join(", ")
    : "ideas centrales y relaciones entre conceptos";
  return [
    `Material académico en español de ${config.subject || "una materia universitaria"}.`,
    config.topic ? `Tema declarado: ${config.topic}.` : "",
    `Objetivo del estudiante: ${PURPOSE_LABELS[config.purpose]}.`,
    `Nivel: ${config.level}. Priorizar: ${focus}.`,
    `Formato final esperado: ${FORMAT_LABELS[config.format]}.`,
    `Fuentes analizadas: ${files.join(", ")}.`,
    config.notes ? `Necesidad adicional: ${config.notes}.` : "",
    "Conservar con precisión nombres de autores, teorías, conceptos, fechas, cifras y relaciones causales.",
    "No agregar conocimiento externo ni completar huecos. Si el material no permite afirmar algo, marcarlo como límite o duda.",
    "Distinguir tesis, argumentos, ejemplos, críticas y comparaciones. Redactar para estudiar, con frases completas y lenguaje claro.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildAiPrompt(config: StudyConfig, files: string[]) {
  const focus = config.focus.length ? config.focus.join(", ") : "ideas principales";
  return `Actuá como asistente de estudio universitario. Leé todo el material antes de responder.

OBJETIVO
Elaborar un resumen académico fiel, comprensible y útil para ${PURPOSE_LABELS[
    config.purpose
  ].toLowerCase()}.

CONFIGURACIÓN
- Materia: ${config.subject || "[completar]"}
- Tema: ${config.topic || "[inferir del material y confirmar]"}
- Nivel: ${config.level}
- Formato: ${FORMAT_LABELS[config.format]}
- Extensión: ${LENGTH_LABELS[config.length]}
- Priorizar: ${focus}
- Archivos: ${files.length ? files.join(", ") : "[adjuntar o pegar material]"}
${config.notes ? `- Necesidad particular: ${config.notes}` : ""}

MÉTODO
1. Identificá la tesis o idea central de cada sección.
2. Separá conceptos, autores, teorías, argumentos, ejemplos y críticas.
3. Explicá las relaciones entre ideas; no armes una lista de frases aisladas.
4. Conservá exactamente nombres, fechas, cifras y fórmulas.
5. Usá solo el material. No inventes ni completes por conocimiento general.
6. Si algo es ambiguo, contradictorio o ilegible, marcá [Requiere revisión].
7. Si hay varias fuentes, señalá coincidencias y diferencias sin atribuir una idea al autor equivocado.

SALIDA
- Ficha del tema
- Idea central
- Resumen organizado por secciones
- Conceptos clave explicados
- Relaciones importantes y comparaciones
- Datos que conviene memorizar
- Dudas o límites del material
- Síntesis final de 3 a 5 líneas
- 5 preguntas de autoevaluación

Al terminar, agregá “Cómo mejorar este resumen” con 3 preguntas concretas para que el estudiante lo revise con sus propias palabras.`;
}

function fallbackMap(text: string, config: StudyConfig) {
  const terms = extractTerms(text, 12);
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 70 && sentence.length < 360);
  const termSet = new Set(terms);
  const scored = sentences
    .map((sentence, index) => {
      const normalized = sentence
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      let score = index < 6 ? 2 : 0;
      for (const term of termSet) if (normalized.includes(term)) score += 1;
      if (/\b(se define|consiste|teoría|concepto|autor|propone|sostiene|implica)\b/i.test(sentence))
        score += 3;
      return { sentence, score, index };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, config.length === "short" ? 6 : config.length === "medium" ? 10 : 14)
    .sort((a, b) => a.index - b.index);

  return `# Mapa previo del material

> Este resultado organiza fragmentos relevantes sin IA generativa. No es todavía el resumen inteligente final.

## Fragmentos para una lectura activa

${scored.map(({ sentence }) => `- ${sentence}`).join("\n")}

## Conceptos que se repiten

${terms.map((term) => `- ${term}`).join("\n")}

## Siguiente paso

Abrí esta página en Chrome actualizado desde una computadora para usar la IA local, o copiá la instrucción optimizada en una herramienta de IA junto con el material.`;
}

async function readPdf(file: File) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(`[Página ${index}]\n${pageText}`);
  }
  return cleanText(pages.join("\n\n"));
}

async function readDocx(file: File) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
  return cleanText(result.value);
}

async function readFileText(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return readPdf(file);
  if (extension === "docx") return readDocx(file);
  if (["txt", "md", "csv", "rtf"].includes(extension ?? "")) {
    return cleanText(await file.text());
  }
  throw new Error("Formato no compatible");
}

async function summarizeSafely(
  summarizer: Summarizer,
  input: string,
  context: string,
) {
  const usage = await summarizer.measureInputUsage(input, { context });
  if (usage <= summarizer.inputQuota) {
    return summarizer.summarize(input, { context });
  }
  const halves = splitByStructure(input, Math.max(2_500, Math.floor(input.length / 2)), 250);
  const outputs: string[] = [];
  for (const half of halves) {
    outputs.push(await summarizer.summarize(half, { context }));
  }
  return outputs.join("\n");
}

function AppIcon({ children }: { children: React.ReactNode }) {
  return <span className="app-icon" aria-hidden="true">{children}</span>;
}

export default function Home() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [config, setConfig] = useState<StudyConfig>(initialConfig);
  const [engine, setEngine] = useState<EngineState>("checking");
  const [hasPromptApi, setHasPromptApi] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [result, setResult] = useState("");
  const [resultMode, setResultMode] = useState<"summary" | "prompt">("summary");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    async function checkEngine() {
      if (typeof Summarizer === "undefined") {
        if (active) setEngine("unavailable");
        return;
      }
      try {
        const availability = await Summarizer.availability({
          type: "key-points",
          format: "markdown",
          length: "long",
          preference: "capability",
          expectedInputLanguages: ["es"],
          expectedContextLanguages: ["es"],
          outputLanguage: "es",
        });
        if (active) {
          setEngine(availability);
          setHasPromptApi(typeof LanguageModel !== "undefined");
        }
      } catch {
        if (active) setEngine("unavailable");
      }
    }
    checkEngine();
    return () => {
      active = false;
    };
  }, []);

  const combinedText = useMemo(() => {
    const fileText = materials
      .filter((material) => material.status === "ready")
      .map((material) => `\n\n===== FUENTE: ${material.name} =====\n\n${material.text}`)
      .join("");
    const pasted = pastedText.trim()
      ? `\n\n===== TEXTO PEGADO =====\n\n${cleanText(pastedText)}`
      : "";
    return cleanText(`${fileText}${pasted}`).slice(0, MAX_TOTAL_CHARS);
  }, [materials, pastedText]);

  const totalWords = wordCount(combinedText);
  const promptText = useMemo(
    () =>
      buildAiPrompt(
        config,
        materials.filter((material) => material.status === "ready").map((material) => material.name),
      ),
    [config, materials],
  );

  const suggestions = useMemo(() => {
    const items: string[] = [];
    if (!config.topic.trim()) items.push("Escribí el tema: ayuda a no mezclar conceptos cercanos.");
    if (materials.length > 1)
      items.push("Indicá autores o unidades si querés comparar sin mezclar atribuciones.");
    if (totalWords > 35_000)
      items.push("Para un resultado más profundo, resumí por capítulo y luego uní las síntesis.");
    if (config.focus.length < 2)
      items.push("Elegí al menos dos focos, por ejemplo Conceptos + Relaciones.");
    if (!config.notes.trim())
      items.push("Podés aclarar qué te cuesta o qué suele tomar el docente.");
    if (!items.length)
      items.push("La configuración está completa. Después revisá el resultado contra el material.");
    return items.slice(0, 3);
  }, [config, materials.length, totalWords]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setIsReading(true);
    setError("");
    const selected = Array.from(files).slice(0, 8);
    const next: Material[] = [];
    for (const file of selected) {
      const id = `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
      if (file.size > MAX_FILE_BYTES) {
        next.push({
          id,
          name: file.name,
          size: file.size,
          text: "",
          status: "error",
          note: "Supera el límite de 18 MB",
        });
        continue;
      }
      try {
        const text = await readFileText(file);
        next.push({
          id,
          name: file.name,
          size: file.size,
          text,
          status: text.length > 80 ? "ready" : "error",
          note: text.length > 80 ? undefined : "No se pudo extraer suficiente texto",
        });
      } catch {
        next.push({
          id,
          name: file.name,
          size: file.size,
          text: "",
          status: "error",
          note: "Usá PDF, DOCX, TXT, MD, CSV o RTF",
        });
      }
    }
    setMaterials((current) => [...current, ...next].slice(0, 8));
    setIsReading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleFocus(item: string) {
    setConfig((current) => ({
      ...current,
      focus: current.focus.includes(item)
        ? current.focus.filter((focus) => focus !== item)
        : [...current.focus, item],
    }));
  }

  async function generateIntelligentSummary() {
    setError("");
    setCopied(false);
    setResultMode("summary");
    if (combinedText.length < 500) {
      setError("Agregá al menos unas páginas de material o pegá un texto más extenso.");
      return;
    }
    if (combinedText.length >= MAX_TOTAL_CHARS) {
      setError(
        "El material supera el límite de esta sesión. Se usarán los primeros 280.000 caracteres; para estudiar mejor, separalo por capítulos.",
      );
    }
    if (typeof Summarizer === "undefined" || engine === "unavailable") {
      setResult(fallbackMap(combinedText, config));
      return;
    }

    setIsGenerating(true);
    setProgressText("Preparando la IA local…");
    const controller = new AbortController();
    const fileNames = materials
      .filter((material) => material.status === "ready")
      .map((material) => material.name);
    const studyContext = buildStudyContext(config, fileNames.length ? fileNames : ["texto pegado"]);
    let chunkSummarizer: Summarizer | null = null;
    let finalSummarizer: Summarizer | null = null;
    let keyPointSummarizer: Summarizer | null = null;
    let languageSession: LanguageModel | null = null;

    try {
      chunkSummarizer = await Summarizer.create({
        sharedContext: studyContext,
        type: "tldr",
        format: "plain-text",
        length: "long",
        preference: "capability",
        expectedInputLanguages: ["es"],
        expectedContextLanguages: ["es"],
        outputLanguage: "es",
        signal: controller.signal,
        monitor(monitor) {
          setEngine("downloading");
          monitor.addEventListener("downloadprogress", (event) => {
            setDownloadProgress(Math.round(event.loaded * 100));
            setProgressText(`Descargando la IA local… ${Math.round(event.loaded * 100)}%`);
          });
        },
      });
      setEngine("available");
      const chunks = splitByStructure(combinedText);
      const partials: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        setProgressText(`Comprendiendo sección ${index + 1} de ${chunks.length}…`);
        partials.push(
          await summarizeSafely(
            chunkSummarizer,
            chunks[index],
            `${studyContext} Esta es una sección de un material más extenso. Conservá los conceptos y relaciones necesarios para la síntesis global.`,
          ),
        );
      }

      let condensed = partials.join("\n\n");
      finalSummarizer = await Summarizer.create({
        sharedContext: studyContext,
        type: "tldr",
        format: "plain-text",
        length: config.length,
        preference: "capability",
        expectedInputLanguages: ["es"],
        expectedContextLanguages: ["es"],
        outputLanguage: "es",
      });
      let pass = 0;
      while (
        (await finalSummarizer.measureInputUsage(condensed, { context: studyContext })) >
          finalSummarizer.inputQuota &&
        pass < 4
      ) {
        pass += 1;
        const groups = splitByStructure(condensed, 6_500, 0);
        const collapsed: string[] = [];
        for (let index = 0; index < groups.length; index += 1) {
          setProgressText(`Integrando conceptos · etapa ${pass}, parte ${index + 1}…`);
          collapsed.push(await summarizeSafely(finalSummarizer, groups[index], studyContext));
        }
        condensed = collapsed.join("\n\n");
      }

      setProgressText("Armando el resumen de estudio…");
      const overview = await summarizeSafely(finalSummarizer, condensed, studyContext);
      keyPointSummarizer = await Summarizer.create({
        sharedContext: studyContext,
        type: "key-points",
        format: "markdown",
        length: config.length,
        preference: "capability",
        expectedInputLanguages: ["es"],
        expectedContextLanguages: ["es"],
        outputLanguage: "es",
      });
      const keyPoints = await summarizeSafely(
        keyPointSummarizer,
        condensed,
        `${studyContext} Seleccioná puntos que ayuden a explicar, no frases sueltas.`,
      );

      const terms = extractTerms(combinedText, config.length === "long" ? 12 : 8);
      const questions = terms
        .slice(0, 5)
        .map((term) => `- ¿Cómo explicarías **${term}** con tus propias palabras y con qué otra idea se relaciona?`)
        .join("\n");

      let finalText = `# ${config.topic || config.subject || "Resumen de estudio"}

> **Objetivo:** ${PURPOSE_LABELS[config.purpose]} · **Nivel:** ${config.level} · **Fuentes:** ${
        fileNames.length ? fileNames.join(", ") : "texto pegado"
      }

## Idea central

${overview}

## Puntos clave

${keyPoints}

## Conceptos para revisar

${terms.map((term) => `- **${term}** — ubicá su definición exacta y su relación con el tema central.`).join("\n")}

## Preguntas de autoevaluación

${questions}

## Límites y revisión

- Verificá nombres, fechas, cifras y atribuciones contra el material.
- Si una idea importante no aparece, agregala después de releer esa sección.
- Explicá el tema en voz alta: si no podés conectar dos conceptos, marcá esa relación para revisar.
`;

      if (typeof LanguageModel !== "undefined") {
        try {
          const languageAvailability = await LanguageModel.availability({
            expectedInputs: [{ type: "text", languages: ["es"] }],
            expectedOutputs: [{ type: "text", languages: ["es"] }],
          });
          if (languageAvailability !== "unavailable") {
            setProgressText("Dándole estructura académica al resultado…");
            languageSession = await LanguageModel.create({
              expectedInputs: [{ type: "text", languages: ["es"] }],
              expectedOutputs: [{ type: "text", languages: ["es"] }],
              samplingMode: "most-predictable",
              initialPrompts: [
                {
                  role: "system",
                  content:
                    "Sos un asistente de estudio riguroso. Organizás únicamente la información provista, no agregás conocimiento externo, no inventás y marcás los límites del material. Respondés en español claro y en Markdown.",
                },
              ],
            });
            const structured = await languageSession.prompt(
              `${buildAiPrompt(config, fileNames)}\n\nMATERIAL YA SINTETIZADO POR SECCIONES:\n${condensed}`,
              { signal: controller.signal },
            );
            if (structured.trim().length > 400) finalText = structured.trim();
          }
        } catch {
          // La salida de Summarizer sigue siendo válida si Prompt API no está lista.
        }
      }

      setResult(finalText);
      setProgressText("Resumen listo para revisar.");
    } catch (generationError) {
      const message =
        generationError instanceof Error ? generationError.message : "No se pudo generar el resumen.";
      setError(
        message.includes("language") || message.includes("Language")
          ? "La IA local todavía no tiene español disponible en este navegador. Actualizá Chrome y volvé a intentar."
          : "La IA local no pudo completar esta sesión. Probá con un capítulo más corto o usá la instrucción optimizada.",
      );
      if (!result) setResult(fallbackMap(combinedText, config));
    } finally {
      chunkSummarizer?.destroy();
      finalSummarizer?.destroy();
      keyPointSummarizer?.destroy();
      languageSession?.destroy();
      setIsGenerating(false);
    }
  }

  async function copyCurrent() {
    const text = resultMode === "summary" ? result : promptText;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadResult() {
    if (!result) return;
    const blob = new Blob([result], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(config.topic || "resumen-de-estudio")
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ]+/gi, "-")
      .replace(/^-|-$/g, "")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const engineCopy =
    engine === "checking"
      ? "Comprobando IA local"
      : engine === "available"
        ? hasPromptApi
          ? "IA local avanzada disponible"
          : "IA local disponible"
        : engine === "downloadable"
          ? "IA local lista para descargar"
          : engine === "downloading"
            ? `Descargando IA local · ${downloadProgress}%`
            : "Modo guía disponible";

  return (
    <main>
      <nav className="topbar" aria-label="Navegación principal">
        <a className="brand" href="#inicio" aria-label="Apunte Claro, inicio">
          <span className="brand-mark">A</span>
          <span>Apunte Claro</span>
        </a>
        <div className="nav-links">
          <a href="#crear">Crear resumen</a>
          <a href="#metodo">Cómo funciona</a>
          <span className={`engine-pill engine-${engine}`}>
            <span className="status-dot" />
            {engineCopy}
          </span>
        </div>
      </nav>

      <section className="hero" id="inicio">
        <div className="hero-copy">
          <span className="eyebrow">Hecho para estudiar, no para recortar texto</span>
          <h1>
            De textos enormes a un
            <span> resumen que entiende el tema.</span>
          </h1>
          <p>
            Subí capítulos, apuntes o varios materiales. La IA trabaja en tu computadora,
            reconoce conceptos y relaciones, y arma una guía según lo que necesitás aprender.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#crear">
              Crear mi resumen <span aria-hidden="true">→</span>
            </a>
            <a className="text-link" href="#privacidad">
              ¿Por qué es gratuito?
            </a>
          </div>
          <div className="trust-row">
            <span><AppIcon>✓</AppIcon> Sin cuenta</span>
            <span><AppIcon>✓</AppIcon> Sin API</span>
            <span><AppIcon>✓</AppIcon> Archivos en tu dispositivo</span>
          </div>
        </div>
        <div className="hero-visual" aria-label="Proceso de resumen inteligente">
          <div className="paper-card paper-source">
            <span className="paper-label">Material</span>
            <div className="line line-wide" />
            <div className="line" />
            <div className="line line-mid" />
            <div className="highlight-line">Teoría del apego</div>
            <div className="line line-wide" />
            <div className="line line-short" />
          </div>
          <div className="process-rail">
            <span>lee</span>
            <span>conecta</span>
            <span>explica</span>
          </div>
          <div className="paper-card paper-result">
            <span className="paper-label">Guía de estudio</span>
            <strong>Idea central</strong>
            <p>Los vínculos tempranos funcionan como modelos para interpretar relaciones posteriores.</p>
            <div className="concept-chip">Bowlby</div>
            <div className="concept-chip">modelos internos</div>
            <div className="concept-chip">base segura</div>
          </div>
        </div>
      </section>

      <section className="creator-shell" id="crear">
        <div className="section-heading">
          <span className="step-kicker">Tu mesa de estudio</span>
          <h2>Armá el resumen en tres pasos</h2>
          <p>Podés combinar archivos y texto pegado. Nada se guarda en una cuenta.</p>
        </div>

        <div className="creator-grid">
          <div className="setup-column">
            <section className="form-card">
              <div className="card-heading">
                <span className="step-number">1</span>
                <div>
                  <h3>Agregá el material</h3>
                  <p>PDF, DOCX, TXT, MD, CSV o RTF · hasta 8 archivos</p>
                </div>
              </div>
              <label
                className={`dropzone ${isReading ? "is-reading" : ""}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  handleFiles(event.dataTransfer.files);
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv,.rtf"
                  onChange={(event) => handleFiles(event.target.files)}
                />
                <span className="upload-icon" aria-hidden="true">↥</span>
                <strong>{isReading ? "Leyendo el material…" : "Arrastrá tus archivos acá"}</strong>
                <span>o hacé clic para elegirlos</span>
              </label>

              {materials.length > 0 && (
                <div className="file-list" aria-live="polite">
                  {materials.map((material) => (
                    <div className={`file-row file-${material.status}`} key={material.id}>
                      <span className="file-type">
                        {material.name.split(".").pop()?.toUpperCase()}
                      </span>
                      <span className="file-info">
                        <strong>{material.name}</strong>
                        <small>
                          {formatBytes(material.size)}
                          {material.note ? ` · ${material.note}` : ` · ${wordCount(material.text).toLocaleString("es-UY")} palabras`}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() =>
                          setMaterials((current) =>
                            current.filter((item) => item.id !== material.id),
                          )
                        }
                        aria-label={`Quitar ${material.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="or-divider"><span>o pegá un fragmento</span></div>
              <label className="field-label" htmlFor="pasted-text">
                Texto del apunte
              </label>
              <textarea
                id="pasted-text"
                value={pastedText}
                onChange={(event) => setPastedText(event.target.value)}
                placeholder="Pegá acá una clase, un capítulo o tus apuntes…"
                rows={5}
              />
              <div className="material-meter">
                <span>{totalWords.toLocaleString("es-UY")} palabras listas</span>
                <span>ideal: un capítulo por sesión</span>
              </div>
            </section>

            <section className="form-card">
              <div className="card-heading">
                <span className="step-number">2</span>
                <div>
                  <h3>Decile qué necesitás</h3>
                  <p>El objetivo cambia qué información conviene priorizar.</p>
                </div>
              </div>

              <div className="field-grid two-columns">
                <label>
                  <span className="field-label">Materia</span>
                  <input
                    value={config.subject}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, subject: event.target.value }))
                    }
                    placeholder="Ej. Psicología social"
                  />
                </label>
                <label>
                  <span className="field-label">Tema</span>
                  <input
                    value={config.topic}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, topic: event.target.value }))
                    }
                    placeholder="Ej. Teorías del aprendizaje"
                  />
                </label>
              </div>

              <div className="field-grid two-columns">
                <label>
                  <span className="field-label">¿Para qué?</span>
                  <select
                    value={config.purpose}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        purpose: event.target.value as StudyConfig["purpose"],
                      }))
                    }
                  >
                    {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Nivel</span>
                  <select
                    value={config.level}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        level: event.target.value as StudyConfig["level"],
                      }))
                    }
                  >
                    <option value="introductorio">Introductorio</option>
                    <option value="intermedio">Intermedio</option>
                    <option value="avanzado">Avanzado</option>
                  </select>
                </label>
              </div>

              <fieldset>
                <legend className="field-label">Qué conviene cuidar</legend>
                <div className="chip-picker">
                  {FOCUS_OPTIONS.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={config.focus.includes(item) ? "is-selected" : ""}
                      aria-pressed={config.focus.includes(item)}
                      onClick={() => toggleFocus(item)}
                    >
                      {config.focus.includes(item) ? "✓ " : "+ "}
                      {item}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="field-grid two-columns">
                <label>
                  <span className="field-label">Formato</span>
                  <select
                    value={config.format}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        format: event.target.value as StudyConfig["format"],
                      }))
                    }
                  >
                    {Object.entries(FORMAT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Profundidad</span>
                  <select
                    value={config.length}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        length: event.target.value as StudyConfig["length"],
                      }))
                    }
                  >
                    {Object.entries(LENGTH_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                <span className="field-label">Algo que te cuesta o querés priorizar</span>
                <textarea
                  value={config.notes}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Ej. Me confundo entre condicionamiento clásico y operante. Comparalos con ejemplos."
                  rows={3}
                />
              </label>
            </section>
          </div>

          <aside className="result-column">
            <section className="coach-card">
              <span className="coach-label"><AppIcon>✦</AppIcon> Cómo mejorar tu pedido</span>
              <ul>
                {suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
              </ul>
            </section>

            <section className="result-card">
              <div className="card-heading result-heading">
                <span className="step-number">3</span>
                <div>
                  <h3>Generá y revisá</h3>
                  <p>La IA propone; vos confirmás que sirva para estudiar.</p>
                </div>
              </div>

              <div className="result-tabs" role="tablist" aria-label="Tipo de resultado">
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultMode === "summary"}
                  className={resultMode === "summary" ? "is-active" : ""}
                  onClick={() => setResultMode("summary")}
                >
                  Resumen
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultMode === "prompt"}
                  className={resultMode === "prompt" ? "is-active" : ""}
                  onClick={() => setResultMode("prompt")}
                >
                  Instrucción para otra IA
                </button>
              </div>

              {resultMode === "summary" ? (
                result ? (
                  <article className="result-output">
                    <pre>{result}</pre>
                  </article>
                ) : (
                  <div className="empty-result">
                    <span aria-hidden="true">◎</span>
                    <strong>Tu guía va a aparecer acá</strong>
                    <p>Agregá material, elegí el enfoque y dejá que la IA conecte las ideas.</p>
                  </div>
                )
              ) : (
                <article className="result-output prompt-output">
                  <pre>{promptText}</pre>
                </article>
              )}

              {progressText && (
                <div className="progress-message" aria-live="polite">
                  <span className={isGenerating ? "spinner" : "done-dot"} />
                  {progressText}
                </div>
              )}
              {error && <div className="error-message" role="alert">{error}</div>}

              <div className="result-actions">
                <button
                  type="button"
                  className="primary-button generate-button"
                  disabled={isGenerating || isReading}
                  onClick={generateIntelligentSummary}
                >
                  {isGenerating ? "Trabajando por secciones…" : "Generar resumen inteligente"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={resultMode === "summary" && !result}
                  onClick={copyCurrent}
                >
                  {copied ? "Copiado ✓" : "Copiar"}
                </button>
                {resultMode === "summary" && result && (
                  <button type="button" className="secondary-button" onClick={downloadResult}>
                    Descargar .md
                  </button>
                )}
              </div>

              <p className="fine-print">
                {engine === "unavailable"
                  ? "En este navegador podés preparar el pedido y obtener un mapa previo. Para la IA local usá Chrome actualizado en una computadora."
                  : "La primera vez, Chrome puede descargar su modelo de IA. Después puede funcionar sin conexión y el material no sale del dispositivo."}
              </p>
            </section>
          </aside>
        </div>
      </section>

      <section className="method-section" id="metodo">
        <div className="section-heading method-heading">
          <span className="step-kicker">Un método, no un atajo</span>
          <h2>La IA acompaña el trabajo de comprender</h2>
          <p>El flujo adapta principios clásicos del resumen a materiales universitarios y herramientas de IA.</p>
        </div>
        <div className="method-grid">
          {[
            ["01", "Leer con contexto", "Primero reconoce el tema, las secciones y el propósito del material."],
            ["02", "Jerarquizar ideas", "Distingue tesis, conceptos, autores, ejemplos, críticas y detalles secundarios."],
            ["03", "Conectar", "Explica relaciones, diferencias, causas y consecuencias; no pega frases sueltas."],
            ["04", "Redactar para estudiar", "Adapta nivel, profundidad y formato a la necesidad del estudiante."],
            ["05", "Revisar límites", "Marca dudas y recuerda verificar datos, atribuciones y partes ilegibles."],
          ].map(([number, title, description]) => (
            <article className="method-card" key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
        <div className="source-note">
          <div>
            <strong>Base pedagógica</strong>
            <p>
              Lectura activa, preguntas, selección de ideas, esquema, redacción propia y revisión.
              La síntesis debe ser clara, coherente y comprensible por sí misma.
            </p>
          </div>
          <a
            href="https://www.educalive.com/blog/como-hacer-resumen"
            target="_blank"
            rel="noreferrer"
          >
            Ver artículo de EducAlive ↗
          </a>
        </div>
      </section>

      <section className="privacy-section" id="privacidad">
        <div className="privacy-copy">
          <span className="step-kicker">Gratis de verdad</span>
          <h2>No necesita cuenta, clave ni servidor de IA.</h2>
          <p>
            En Chrome actualizado para computadora, el modelo se ejecuta en el propio dispositivo.
            El sitio no recibe el contenido de los apuntes. La descarga inicial del modelo puede ser grande
            y requiere un equipo compatible; por eso siempre queda disponible la instrucción para otra IA.
          </p>
        </div>
        <div className="privacy-facts">
          <div><strong>Local</strong><span>el texto se procesa en tu equipo</span></div>
          <div><strong>Sin registro</strong><span>no hay perfiles ni historial en la nube</span></div>
          <div><strong>Honesto</strong><span>la IA puede equivocarse: el control final es humano</span></div>
        </div>
      </section>

      <footer>
        <div className="brand"><span className="brand-mark">A</span><span>Apunte Claro</span></div>
        <p>Una herramienta gratuita para estudiar con criterio.</p>
        <a href="#inicio">Volver arriba ↑</a>
      </footer>
    </main>
  );
}
