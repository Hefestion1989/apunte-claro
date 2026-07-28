"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildExternalPackage,
  buildIntegrationSource,
  buildLocalSummaryPlan,
  buildPartialSummary,
  buildSectionLabels,
  isIncompleteSummary,
  runSectionSummaries,
  splitByStructure,
  SummaryCancelled,
} from "@/lib/summary-pipeline";

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

type UseMode = "local" | "chatgpt" | "other";
type ExternalProvider = "gemini" | "claude" | "copilot" | "other";

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
const MAX_LOCAL_CHARS = 1_500_000;

const EXTERNAL_PROVIDERS: Record<
  ExternalProvider,
  { name: string; icon: string; url: string | null; accountNote: string; description: string }
> = {
  gemini: {
    name: "Gemini",
    icon: "✦",
    url: "https://gemini.google.com/",
    accountNote: "Algunas funciones pueden usarse sin cuenta; Google puede pedir acceso para otras.",
    description: "La IA de Google. Algunas funciones web están disponibles sin iniciar sesión.",
  },
  copilot: {
    name: "Copilot",
    icon: "◈",
    url: "https://copilot.microsoft.com/",
    accountNote: "Puede pedir una cuenta para guardar chats o usar funciones adicionales.",
    description: "La IA de Microsoft. Se abre directamente en el navegador.",
  },
  claude: {
    name: "Claude",
    icon: "C",
    url: "https://claude.ai/",
    accountNote: "Claude requiere crear una cuenta, aunque tiene una opción gratuita.",
    description: "La IA de Anthropic. Tiene un plan gratuito, pero pide registro.",
  },
  other: {
    name: "Otra herramienta",
    icon: "◇",
    url: null,
    accountNote: "La cuenta, gratuidad y límites dependen de la herramienta elegida.",
    description: "Descargá un archivo universal para usarlo en cualquier asistente.",
  },
};

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
  short: "Breve · más rápido",
  medium: "Equilibrado · recomendado",
  long: "Profundo · más lento",
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
    .replace(/Encuentre más documentos universitarios en https?:\/\/apunty\.com/gi, "")
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

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} min ${String(seconds).padStart(2, "0")} s` : `${seconds} s`;
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

function fallbackSection(text: string, config: StudyConfig) {
  const map = fallbackMap(text, { ...config, length: "short" });
  return `[Sección organizada sin IA generativa]\n\n${map
    .replace(/^# Mapa previo del material\s*/i, "")
    .replace(/## Siguiente paso[\s\S]*$/i, "")
    .trim()}`;
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
  signal?: AbortSignal,
  depth = 0,
  retryIncomplete = true,
) {
  if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
  const usage = await summarizer.measureInputUsage(input, { context });
  if (usage <= summarizer.inputQuota) {
    const summary = await summarizer.summarize(input, { context, signal });
    if (retryIncomplete && isIncompleteSummary(summary) && input.length > 2_400 && depth < 2) {
      const retryParts = splitByStructure(
        input,
        Math.max(2_400, Math.floor(input.length / 2)),
        0,
      );
      if (retryParts.length > 1) {
        const completed: string[] = [];
        for (const part of retryParts) {
          completed.push(
            await summarizeSafely(
              summarizer,
              part,
              `${context} Este subfragmento se generó porque la primera síntesis quedó cortada. Cerrá todas las ideas con oraciones completas.`,
              signal,
              depth + 1,
              retryIncomplete,
            ),
          );
        }
        return completed.join("\n\n");
      }
    }
    return isIncompleteSummary(summary)
      ? `${summary.trim()}\n\n[Requiere revisión: la IA local dejó esta idea incompleta.]`
      : summary;
  }
  const halves = splitByStructure(input, Math.max(1_200, Math.floor(input.length / 2)), 0);
  if (halves.length < 2) return summarizer.summarize(input, { context, signal });
  const outputs: string[] = [];
  for (const half of halves) {
    outputs.push(
      await summarizeSafely(
        summarizer,
        half,
        context,
        signal,
        depth + 1,
        retryIncomplete,
      ),
    );
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
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [averageSectionSeconds, setAverageSectionSeconds] = useState(0);
  const [completedSections, setCompletedSections] = useState(0);
  const [totalSections, setTotalSections] = useState(0);
  const [result, setResult] = useState("");
  const [resultMode, setResultMode] = useState<"summary" | "prompt">("summary");
  const [useMode, setUseMode] = useState<UseMode | null>(null);
  const [externalProvider, setExternalProvider] = useState<ExternalProvider | null>(null);
  const [showModeChooser, setShowModeChooser] = useState(true);
  const [chooserStep, setChooserStep] = useState<"mode" | "provider" | "about">("mode");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const generationStartedAtRef = useRef<number | null>(null);

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
        if (active) setEngine(availability);
      } catch {
        if (active) setEngine("unavailable");
      }
    }
    checkEngine();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isGenerating || generationStartedAtRef.current === null) return;
    const updateElapsed = () => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - generationStartedAtRef.current!) / 1_000)),
      );
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  const combinedText = useMemo(() => {
    const fileText = materials
      .filter((material) => material.status === "ready")
      .map((material) => `\n\n===== FUENTE: ${material.name} =====\n\n${material.text}`)
      .join("");
    const pasted = pastedText.trim()
      ? `\n\n===== TEXTO PEGADO =====\n\n${cleanText(pastedText)}`
      : "";
    return cleanText(`${fileText}${pasted}`);
  }, [materials, pastedText]);

  const totalWords = wordCount(combinedText);
  const localSummaryPlan = useMemo(
    () => buildLocalSummaryPlan(totalWords, config.length),
    [config.length, totalWords],
  );
  const estimatedSections = useMemo(
    () =>
      combinedText.length
        ? splitByStructure(combinedText, localSummaryPlan.chunkChars, 0).length
        : 0,
    [combinedText, localSummaryPlan.chunkChars],
  );
  const promptText = useMemo(
    () =>
      buildAiPrompt(
        config,
        materials.filter((material) => material.status === "ready").map((material) => material.name),
      ),
    [config, materials],
  );
  const selectedProvider = externalProvider ? EXTERNAL_PROVIDERS[externalProvider] : null;
  const destinationName =
    useMode === "chatgpt" ? "ChatGPT" : selectedProvider?.name ?? "otra IA";

  const suggestions = useMemo(() => {
    const items: string[] = [];
    if (!config.topic.trim()) items.push("Escribí el tema: ayuda a no mezclar conceptos cercanos.");
    if (materials.length > 1)
      items.push("Indicá autores o unidades si querés comparar sin mezclar atribuciones.");
    if (localSummaryPlan.optimized)
      items.push(
        "Documento enorme: activaremos un modo local compacto para reducir el tiempo. Por capítulos sigue siendo más preciso.",
      );
    if (config.focus.length < 2)
      items.push("Elegí al menos dos focos, por ejemplo Conceptos + Relaciones.");
    if (!config.notes.trim())
      items.push("Podés aclarar qué te cuesta o qué suele tomar el docente.");
    if (!items.length)
      items.push("La configuración está completa. Después revisá el resultado contra el material.");
    return items.slice(0, 3);
  }, [config, localSummaryPlan.optimized, materials.length]);

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

  function chooseMode(mode: UseMode) {
    if (mode === "other") {
      setChooserStep("provider");
      return;
    }
    setUseMode(mode);
    setExternalProvider(null);
    setResultMode(mode === "local" ? "summary" : "prompt");
    setShowModeChooser(false);
    setError("");
    setProgressText("");
    window.setTimeout(() => document.querySelector("#crear")?.scrollIntoView({ behavior: "smooth" }), 120);
  }

  function chooseExternalProvider(provider: ExternalProvider) {
    setUseMode("other");
    setExternalProvider(provider);
    setResultMode("prompt");
    setShowModeChooser(false);
    setChooserStep("mode");
    setError("");
    setProgressText("");
    window.setTimeout(() => document.querySelector("#crear")?.scrollIntoView({ behavior: "smooth" }), 120);
  }

  function openModeChooser() {
    setChooserStep("mode");
    setShowModeChooser(true);
  }

  function openFreeInfo() {
    setChooserStep("about");
    setShowModeChooser(true);
  }

  function closeFreeInfo() {
    setChooserStep("mode");
    setShowModeChooser(false);
  }

  function prepareExternalPackage() {
    setError("");
    setCopied(false);
    setResultMode("prompt");
    if (combinedText.length < 500) {
      setError("Agregá al menos unas páginas de material o pegá un texto más extenso.");
      return;
    }
    setProgressText(
      useMode === "chatgpt"
        ? "Paquete listo. Copiá la instrucción o descargá el material para abrirlo en ChatGPT."
        : `Paquete listo. Copiá la instrucción o descargá el material para abrirlo en ${destinationName}.`,
    );
  }

  async function generateIntelligentSummary() {
    setError("");
    setCopied(false);
    setResultMode("summary");
    setResult("");
    setProgressText("");
    setProgressPercent(0);
    setElapsedSeconds(0);
    setAverageSectionSeconds(0);
    setCompletedSections(0);
    setTotalSections(0);
    if (combinedText.length < 500) {
      setError("Agregá al menos unas páginas de material o pegá un texto más extenso.");
      return;
    }
    if (combinedText.length > MAX_LOCAL_CHARS) {
      setError(
        "Este documento es demasiado grande para procesarlo de forma segura en una sola sesión local. No se recortó nada: separalo por capítulos o preparalo para una IA externa.",
      );
      return;
    }
    if (typeof Summarizer === "undefined" || engine === "unavailable") {
      setResult(fallbackMap(combinedText, config));
      setProgressText("Mapa previo listo. Este navegador no ofrece la IA local.");
      setProgressPercent(100);
      return;
    }

    generationStartedAtRef.current = Date.now();
    setIsGenerating(true);
    setProgressText("Preparando la IA local…");
    const controller = new AbortController();
    generationControllerRef.current = controller;
    const fileNames = materials
      .filter((material) => material.status === "ready")
      .map((material) => material.name);
    const studyContext = buildStudyContext(config, fileNames.length ? fileNames : ["texto pegado"]);
    const generationPlan = buildLocalSummaryPlan(totalWords, config.length);
    const sectionContext = `${studyContext}
Trabajá exclusivamente con el fragmento recibido. No arrastres temas de otra sección ni completes con conocimiento general.
Identificá quién sostiene cada tesis y no atribuyas al autor comentado una interpretación formulada por quien lo analiza.
No conviertas bibliografías, índices, carátulas, encabezados ni títulos aislados en conclusiones. Mencioná un autor únicamente si el fragmento desarrolla una idea atribuida de forma explícita.
Priorizá únicamente información verificable y útil para estudiar: idea central, conceptos, relaciones, argumentos, ejemplos y críticas.
Omití introducciones genéricas y frases que no agreguen contenido. Si el fragmento comienza o termina a mitad de una idea, marcá [Fragmento incompleto] sin inventar la continuación.
Cerrá cada punto con una oración completa.
${generationPlan.optimized ? "Este es un documento enorme: elegí sólo las ideas de mayor valor académico y evitá repeticiones. Cada punto debe ser breve, específico y atribuible al material." : ""}`;
    let chunkSummarizer: Summarizer | null = null;
    let finalSummarizer: Summarizer | null = null;
    let keyPointSummarizer: Summarizer | null = null;
    let completedPartials: string[] = [];
    let plannedTotal = 0;
    let plannedLabels: string[] = [];
    let recoveredSections = 0;
    const sectionDurations: number[] = [];

    try {
      chunkSummarizer = await Summarizer.create({
        sharedContext: studyContext,
        type: generationPlan.sectionType,
        format: generationPlan.sectionFormat,
        length: generationPlan.sectionLength,
        preference: generationPlan.preference,
        expectedInputLanguages: ["es"],
        expectedContextLanguages: ["es"],
        outputLanguage: "es",
        signal: controller.signal,
        monitor(monitor) {
          setEngine("downloading");
          monitor.addEventListener("downloadprogress", (event) => {
            setDownloadProgress(Math.round(event.loaded * 100));
            setProgressText(`Descargando la IA local… ${Math.round(event.loaded * 100)}%`);
            setProgressPercent(Math.max(1, Math.round(event.loaded * 8)));
          });
        },
      });
      setEngine("available");
      setProgressText(
        generationPlan.optimized
          ? "Activando el modo compacto para documento enorme…"
          : "Organizando el documento completo en secciones…",
      );
      setProgressPercent(8);
      const chunks = splitByStructure(combinedText, generationPlan.chunkChars, 0);
      plannedTotal = chunks.length;
      plannedLabels = buildSectionLabels(chunks);
      setTotalSections(plannedTotal);

      const partials = await runSectionSummaries({
        chunks,
        signal: controller.signal,
        summarize: async (chunk, index) => {
          setProgressText(
            `${generationPlan.optimized ? "Extrayendo lo esencial" : "Comprendiendo"} · sección ${index + 1} de ${chunks.length}`,
          );
          setProgressPercent(10 + Math.round((index / chunks.length) * 65));
          const sectionStartedAt = Date.now();
          const partial = await summarizeSafely(
            chunkSummarizer!,
            chunk,
            sectionContext,
            controller.signal,
            0,
            generationPlan.retryIncomplete,
          );
          sectionDurations.push(Math.max(1, (Date.now() - sectionStartedAt) / 1_000));
          const recentDurations = sectionDurations.slice(-3);
          setAverageSectionSeconds(
            recentDurations.reduce((sum, duration) => sum + duration, 0) /
              recentDurations.length,
          );
          return partial;
        },
        recover: (_sectionError, chunk) => {
          recoveredSections += 1;
          return fallbackSection(chunk, config);
        },
        onProgress(progress) {
          completedPartials = progress.partials;
          setCompletedSections(progress.completed);
          setProgressPercent(10 + Math.round((progress.completed / progress.total) * 65));
          setProgressText(
            `${generationPlan.optimized ? "Extracción compacta" : "Comprendiendo"} · sección ${progress.completed} de ${progress.total} · borrador disponible`,
          );
          setResult(
            buildPartialSummary(
              progress.partials,
              progress.total,
              config.topic || config.subject || "Resumen de estudio",
              "working",
              plannedLabels,
            ),
          );
        },
      });

      let condensed = generationPlan.optimized
        ? buildIntegrationSource(partials, 3)
        : partials.join("\n\n");
      finalSummarizer = await Summarizer.create({
        sharedContext: studyContext,
        type: "tldr",
        format: "plain-text",
        length: generationPlan.finalLength,
        preference: generationPlan.preference,
        expectedInputLanguages: ["es"],
        expectedContextLanguages: ["es"],
        outputLanguage: "es",
        signal: controller.signal,
      });
      let pass = 0;
      while (
        !generationPlan.optimized &&
        (await finalSummarizer.measureInputUsage(condensed, { context: studyContext })) >
          finalSummarizer.inputQuota &&
        pass < 4
      ) {
        if (controller.signal.aborted) throw new SummaryCancelled(completedPartials, plannedTotal);
        pass += 1;
        const groups = splitByStructure(condensed, 16_000, 0);
        const collapsed: string[] = [];
        for (let index = 0; index < groups.length; index += 1) {
          setProgressText(
            `Integrando conceptos · etapa ${pass}, parte ${index + 1} de ${groups.length}…`,
          );
          setProgressPercent(Math.min(88, 75 + pass * 3));
          collapsed.push(
            await summarizeSafely(
              finalSummarizer,
              groups[index],
              studyContext,
              controller.signal,
            ),
          );
        }
        condensed = collapsed.join("\n\n");
      }

      setProgressText("Armando el resumen de estudio…");
      setProgressPercent(90);
      const overview = await summarizeSafely(
        finalSummarizer,
        condensed,
        `${studyContext}
Integrá únicamente relaciones explícitas en las síntesis. No completes autores, teorías ni conclusiones con conocimiento externo.`,
        controller.signal,
        0,
        generationPlan.retryIncomplete,
      );
      let keyPoints = "";
      if (generationPlan.includeIntegratedKeyPoints) {
        keyPointSummarizer = await Summarizer.create({
          sharedContext: studyContext,
          type: "key-points",
          format: "markdown",
          length: config.length,
          preference: generationPlan.preference,
          expectedInputLanguages: ["es"],
          expectedContextLanguages: ["es"],
          outputLanguage: "es",
          signal: controller.signal,
        });
        setProgressText("Seleccionando puntos verificables…");
        setProgressPercent(96);
        keyPoints = await summarizeSafely(
          keyPointSummarizer,
          condensed,
          `${studyContext}
Seleccioná puntos que ayuden a explicar, no frases sueltas.
No cambies atribuciones ni unas ideas de autores distintos. Si una relación no está explícita en las síntesis, omitila.`,
          controller.signal,
        );
      }

      const terms = extractTerms(combinedText, config.length === "long" ? 12 : 8);
      const questions = terms
        .slice(0, 5)
        .map((term) => `- ¿Cómo explicarías **${term}** con tus propias palabras y con qué otra idea se relaciona?`)
        .join("\n");

      const sectionGuide = partials
        .map(
          (partial, index) =>
            `### ${plannedLabels[index] || `Sección ${index + 1}`}\n\n${partial}`,
        )
        .join("\n\n");

      const finalText = `# ${config.topic || config.subject || "Resumen de estudio"}

> **Objetivo:** ${PURPOSE_LABELS[config.purpose]} · **Nivel:** ${config.level} · **Fuentes:** ${
        fileNames.length ? fileNames.join(", ") : "texto pegado"
      }

> Esta versión conserva las síntesis por sección y no vuelve a reescribirlas libremente. Usá las páginas o fragmentos indicados para verificar cada idea.
${generationPlan.optimized ? "\n> **Modo compacto para documento enorme:** se priorizaron conceptos, relaciones y atribuciones esenciales para reducir el tiempo local. Para máxima profundidad, procesá un capítulo por vez." : ""}

## Orientación general

${overview}

${keyPoints ? `## Puntos clave\n\n${keyPoints}\n` : ""}

## Recorrido fiel por secciones

${sectionGuide}

## Conceptos para revisar

${terms.map((term) => `- **${term}** — ubicá su definición exacta y su relación con el tema central.`).join("\n")}

## Preguntas de autoevaluación

${questions}

## Límites y revisión

- Verificá nombres, fechas, cifras y atribuciones contra el material.
- Si una idea importante no aparece, agregala después de releer esa sección.
- Explicá el tema en voz alta: si no podés conectar dos conceptos, marcá esa relación para revisar.
${recoveredSections ? `- ${recoveredSections} sección(es) se organizaron con el modo de respaldo porque la IA local falló en ese tramo.` : ""}
`;

      setResult(finalText);
      setProgressText("Resumen completo listo para revisar.");
      setProgressPercent(100);
    } catch (generationError) {
      if (generationError instanceof SummaryCancelled || controller.signal.aborted) {
        const partials =
          generationError instanceof SummaryCancelled
            ? generationError.partials
            : completedPartials;
        if (partials.length) {
          setResult(
            buildPartialSummary(
              partials,
              plannedTotal || partials.length,
              config.topic || config.subject || "Resumen de estudio",
              "cancelled",
              plannedLabels,
            ),
          );
        } else {
          setResult("# Resumen detenido\n\nLa generación se canceló antes de completar la primera sección.");
        }
        setProgressText(
          partials.length
            ? `Detenido. Conservamos ${partials.length} de ${plannedTotal || partials.length} secciones.`
            : "Generación detenida.",
        );
        setProgressPercent(
          plannedTotal ? Math.round((partials.length / plannedTotal) * 75) : 0,
        );
        return;
      }
      const message =
        generationError instanceof Error ? generationError.message : "No se pudo generar el resumen.";
      setError(
        message.includes("language") || message.includes("Language")
          ? "La IA local todavía no tiene español disponible en este navegador. Actualizá Chrome y volvé a intentar."
          : completedPartials.length
            ? "La IA local se interrumpió, pero conservamos el borrador parcial para que no pierdas el trabajo."
            : "La IA local no pudo completar esta sesión. Podés volver a intentar o usar la instrucción optimizada.",
      );
      setResult(
        completedPartials.length
          ? buildPartialSummary(
              completedPartials,
              plannedTotal || completedPartials.length,
              config.topic || config.subject || "Resumen de estudio",
              "error",
              plannedLabels,
            )
          : fallbackMap(combinedText, config),
      );
    } finally {
      chunkSummarizer?.destroy();
      finalSummarizer?.destroy();
      keyPointSummarizer?.destroy();
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
      }
      setIsGenerating(false);
    }
  }

  function cancelGeneration() {
    generationControllerRef.current?.abort();
    setProgressText("Deteniendo y conservando lo ya procesado…");
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

  function downloadExternalPackage() {
    if (combinedText.length < 500) {
      setError("Agregá material antes de descargar el paquete.");
      return;
    }
    const destination = destinationName;
    const packageText = buildExternalPackage(destination, promptText, combinedText);
    const blob = new Blob([packageText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `paquete-para-${destination
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ]+/gi, "-")
      .replace(/^-|-$/g, "")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const engineCopy =
    engine === "checking"
      ? "Comprobando IA local"
      : engine === "available"
        ? "IA local disponible"
        : engine === "downloadable"
          ? "IA local lista para descargar"
          : engine === "downloading"
            ? `Descargando IA local · ${downloadProgress}%`
            : "Modo guía disponible";
  const estimatedRemainingSeconds =
    isGenerating && averageSectionSeconds > 0 && totalSections > 0
      ? Math.ceil(
          averageSectionSeconds *
            (Math.max(0, totalSections - completedSections) +
              (localSummaryPlan.optimized ? 1 : 2)),
        )
      : 0;

  return (
    <main>
      {showModeChooser && (
        <div className="mode-overlay">
          <section
            className="mode-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-title"
            aria-describedby="mode-description"
          >
            {chooserStep === "mode" ? (
              <>
                <div className="mode-dialog-heading">
                  <span className="mode-brand"><span className="brand-mark">A</span> Apunte Claro</span>
                  <span className="mode-kicker">Gratis · sin cuenta para entrar</span>
                  <h2 id="mode-title">Elegí cómo querés resumir</h2>
                  <p id="mode-description">
                    No necesitás entender de IA. Elegí una opción y Apunte Claro te va guiando.
                  </p>
                </div>

                <div className="mode-options">
                  <button type="button" className="mode-option mode-option-local" onClick={() => chooseMode("local")}>
                    <span className="mode-icon" aria-hidden="true">⌁</span>
                    <span className="mode-option-copy">
                      <strong>Hacerlo acá</strong>
                      <small>IA local · sin cuenta</small>
                      <span>La opción más privada. Resume en Chrome y tus apuntes no salen del dispositivo.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>

                  <button type="button" className="mode-option" onClick={() => chooseMode("chatgpt")}>
                    <span className="mode-icon" aria-hidden="true">✦</span>
                    <span className="mode-option-copy">
                      <strong>Usar ChatGPT</strong>
                      <small>Puede funcionar sin cuenta</small>
                      <span>Preparamos todo. Después sólo copiás o adjuntás el archivo en ChatGPT.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>

                  <button type="button" className="mode-option" onClick={() => chooseMode("other")}>
                    <span className="mode-icon" aria-hidden="true">◇</span>
                    <span className="mode-option-copy">
                      <strong>Elegir otra IA</strong>
                      <small>Gemini, Copilot, Claude u otra</small>
                      <span>Primero elegís cuál. Después te mostramos exactamente qué hacer.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>
                </div>

                <p className="mode-privacy">
                  Apunte Claro no pide cuenta ni envía nada por su cuenta. Si una plataforma externa
                  te solicita acceso, siempre podés volver y elegir IA local.
                </p>
                <div className="mode-links">
                  <a href="https://www.educalive.com/blog/como-hacer-resumen" target="_blank" rel="noreferrer">
                    Método de estudio inspirado en EducAlive ↗
                  </a>
                  <a href="https://help.openai.com/en/articles/9125172-the-chatgpt-home-page" target="_blank" rel="noreferrer">
                    Disponibilidad de ChatGPT sin cuenta ↗
                  </a>
                </div>
              </>
            ) : chooserStep === "provider" ? (
              <>
                <button type="button" className="provider-back" onClick={() => setChooserStep("mode")}>
                  ← Volver
                </button>
                <div className="mode-dialog-heading">
                  <span className="mode-kicker">Un toque más</span>
                  <h2 id="mode-title">¿Cuál querés usar?</h2>
                  <p id="mode-description">
                    Elegí por nombre. No hace falta configurar claves ni conectar cuentas con Apunte Claro.
                  </p>
                </div>

                <div className="mode-options provider-options">
                  {(Object.entries(EXTERNAL_PROVIDERS) as [
                    ExternalProvider,
                    (typeof EXTERNAL_PROVIDERS)[ExternalProvider],
                  ][]).map(([key, provider]) => (
                    <button
                      key={key}
                      type="button"
                      className="mode-option provider-option"
                      onClick={() => chooseExternalProvider(key)}
                    >
                      <span className="mode-icon provider-icon" aria-hidden="true">{provider.icon}</span>
                      <span className="mode-option-copy">
                        <strong>{provider.name}</strong>
                        <span>{provider.description}</span>
                      </span>
                      <span className="mode-arrow" aria-hidden="true">→</span>
                    </button>
                  ))}
                </div>

                <p className="mode-privacy">
                  Vas a seguir dentro de Apunte Claro hasta que presiones “Abrir la herramienta”.
                  Tus materiales nunca se transfieren automáticamente.
                </p>
              </>
            ) : (
              <>
                <button type="button" className="provider-back" onClick={closeFreeInfo}>
                  ← Volver a Apunte Claro
                </button>
                <div className="mode-dialog-heading about-heading">
                  <span className="mode-brand"><span className="brand-mark">A</span> Apunte Claro</span>
                  <span className="mode-kicker">Cómo funciona de verdad</span>
                  <h2 id="mode-title">¿Por qué puede ser gratis?</h2>
                  <p id="mode-description">
                    Porque en el modo local no alquilamos una IA por cada resumen: usamos la
                    inteligencia artificial que Chrome puede ejecutar en tu propia computadora.
                  </p>
                </div>

                <div className="about-grid">
                  <article>
                    <span className="about-number">01</span>
                    <h3>El modelo es Gemini Nano</h3>
                    <p>
                      Apunte Claro utiliza la API Summarizer integrada en Chrome. Actualmente esa
                      función trabaja con Gemini Nano, un modelo pequeño administrado y actualizado
                      por el navegador.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">02</span>
                    <h3>No hay una API paga</h3>
                    <p>
                      En modo local no necesitás clave, crédito ni cuenta. El modelo se descarga la
                      primera vez y después procesa el texto en el equipo. Por eso puede tardar más.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">03</span>
                    <h3>Tus apuntes quedan en el dispositivo</h3>
                    <p>
                      Apunte Claro no sube los archivos a un servidor de IA. Si elegís ChatGPT,
                      Gemini, Claude o Copilot, recién compartís el material cuando vos lo copiás o
                      adjuntás allí.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">04</span>
                    <h3>También tiene límites</h3>
                    <p>
                      Requiere Chrome actualizado y una computadora compatible. El modelo local
                      puede equivocarse, tiene menos contexto que una IA de servidor y no reemplaza
                      la revisión del material original.
                    </p>
                  </article>
                </div>

                <div className="model-note">
                  <strong>¿Qué versión exacta tengo?</strong>
                  <p>
                    Chrome elige y actualiza el modelo según el equipo. La página no puede leer su
                    número de versión; podés comprobarlo manualmente en{" "}
                    <code>chrome://on-device-internals</code>.
                  </p>
                </div>

                <div className="about-actions">
                  <button type="button" className="primary-button" onClick={closeFreeInfo}>
                    Entendido, volver
                  </button>
                  <a
                    href="https://developer.chrome.com/docs/ai/summarizer-api"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ver documentación oficial de Chrome ↗
                  </a>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <nav className="topbar" aria-label="Navegación principal">
        <a className="brand" href="#inicio" aria-label="Apunte Claro, inicio">
          <span className="brand-mark">A</span>
          <span>Apunte Claro</span>
        </a>
        <div className="nav-links">
          <a href="#crear">Crear resumen</a>
          <a href="#metodo">Cómo funciona</a>
          <button type="button" className="mode-switch" onClick={openModeChooser}>
            {useMode === "chatgpt"
              ? "Modo: ChatGPT"
              : useMode === "other"
                ? `Modo: ${destinationName}`
                : "Cambiar modo"}
          </button>
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
            <button type="button" className="text-link" onClick={openFreeInfo}>
              ¿Por qué es gratuito?
            </button>
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
                <span>
                  {estimatedSections
                    ? `estimación inicial: ${estimatedSections} secciones`
                    : "agregá material para comenzar"}
                </span>
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
                  <p>
                    {useMode === "local"
                      ? "La IA propone; vos confirmás que sirva para estudiar."
                      : "Preparamos el pedido; vos decidís dónde y qué compartir."}
                  </p>
                </div>
              </div>

              {useMode === "local" ? (
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
              ) : (
                <div className="selected-mode-banner">
                  <span aria-hidden="true">{useMode === "chatgpt" ? "✦" : selectedProvider?.icon ?? "◇"}</span>
                  <div>
                    <strong>Elegiste {destinationName}</strong>
                    <small>El material no se envía automáticamente.</small>
                  </div>
                  <button type="button" onClick={openModeChooser}>Cambiar</button>
                </div>
              )}

              {useMode && useMode !== "local" && (
                <div className="external-howto">
                  <strong>Qué vas a hacer</strong>
                  <ol>
                    <li><span>1</span> Agregá tus apuntes y elegí cómo querés estudiar.</li>
                    <li><span>2</span> Presioná “Preparar para {destinationName}”.</li>
                    <li>
                      <span>3</span> Descargá el paquete, abrí {destinationName} y adjuntá el archivo.
                      Si no permite adjuntarlo, copiá la instrucción.
                    </li>
                  </ol>
                </div>
              )}

              {useMode === "local" && resultMode === "summary" ? (
                result ? (
                  <article className="result-output">
                    <pre>{result}</pre>
                  </article>
                ) : (
                  <div className="empty-result">
                    <span aria-hidden="true">◎</span>
                    <strong>
                      {isGenerating ? "Preparando la primera parte…" : "Tu guía va a aparecer acá"}
                    </strong>
                    <p>
                      {isGenerating
                        ? "En cuanto termine la primera sección vas a poder leer un borrador, sin esperar al final."
                        : "Agregá material, elegí el enfoque y dejá que la IA conecte las ideas."}
                    </p>
                  </div>
                )
              ) : (
                <article className="result-output prompt-output">
                  <pre>{promptText}</pre>
                </article>
              )}

              {progressText && (
                <div className="progress-block" aria-live="polite">
                  <div className="progress-message">
                    <span className={isGenerating ? "spinner" : "done-dot"} />
                    <span>{progressText}</span>
                    <strong>{progressPercent}% · {formatElapsed(elapsedSeconds)}</strong>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Progreso del resumen"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent}
                  >
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                  {isGenerating && completedSections > 0 && (
                    <small>
                      El borrador parcial ya se puede leer, copiar o descargar. Si detenés el
                      proceso, conservamos {completedSections} de {totalSections} secciones.
                      {estimatedRemainingSeconds > 0 &&
                        ` Tiempo restante estimado según el ritmo reciente: ${formatElapsed(estimatedRemainingSeconds)} (puede variar).`}
                    </small>
                  )}
                  {isGenerating && localSummaryPlan.optimized && (
                    <small>
                      Modo compacto activo: menos texto repetido y una sola integración final.
                    </small>
                  )}
                  {isGenerating && (
                    <small>
                      El porcentaje indica la etapa; el tiempo muestra lo realmente transcurrido.
                    </small>
                  )}
                </div>
              )}
              {error && <div className="error-message" role="alert">{error}</div>}

              <div className="result-actions">
                <button
                  type="button"
                  className="primary-button generate-button"
                  disabled={isGenerating || isReading}
                  onClick={useMode === "local" ? generateIntelligentSummary : prepareExternalPackage}
                >
                  {isGenerating
                    ? "Trabajando por secciones…"
                    : useMode === "chatgpt"
                      ? "Preparar para ChatGPT"
                      : useMode === "other"
                        ? `Preparar para ${destinationName}`
                        : "Generar resumen inteligente"}
                </button>
                {isGenerating && useMode === "local" && (
                  <button
                    type="button"
                    className="secondary-button cancel-button"
                    onClick={cancelGeneration}
                  >
                    Detener y conservar
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={resultMode === "summary" && !result}
                  onClick={copyCurrent}
                >
                  {copied
                    ? "Copiado ✓"
                    : useMode && useMode !== "local"
                      ? "Copiar instrucción"
                      : "Copiar"}
                </button>
                {resultMode === "summary" && result && (
                  <button type="button" className="secondary-button" onClick={downloadResult}>
                    Descargar .md
                  </button>
                )}
                {useMode && useMode !== "local" && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={combinedText.length < 500}
                    onClick={downloadExternalPackage}
                  >
                    Descargar paquete .txt
                  </button>
                )}
                {(useMode === "chatgpt" || selectedProvider?.url) && (
                  <a
                    className="secondary-button external-button"
                    href={useMode === "chatgpt" ? "https://chatgpt.com/" : selectedProvider?.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir {destinationName} ↗
                  </a>
                )}
              </div>

              <p className="fine-print">
                {useMode === "chatgpt"
                  ? "Apunte Claro no envía nada. ChatGPT puede funcionar sin cuenta según la región; sin iniciar sesión, el chat no se guarda."
                  : useMode === "other"
                    ? `Apunte Claro no envía nada. ${selectedProvider?.accountNote ?? "La disponibilidad y los requisitos dependen de la herramienta que elijas."}`
                    : engine === "unavailable"
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
            En Chrome actualizado para computadora, Gemini Nano se ejecuta en el propio
            dispositivo mediante la API Summarizer del navegador. El sitio no recibe el contenido
            de los apuntes. La descarga inicial puede ser grande y requiere un equipo compatible;
            por eso siempre queda disponible la instrucción para otra IA.
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
