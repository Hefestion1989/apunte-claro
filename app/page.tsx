"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeExternalMaterial,
  buildExternalPackage,
  buildExternalIntegrationPrompt,
  buildExternalPartPackage,
  buildIntegrationSource,
  buildLocalSummaryPlan,
  buildPartialSummary,
  buildSectionLabels,
  isIncompleteSummary,
  runSectionSummaries,
  splitByStructure,
  SummaryCancelled,
} from "@/lib/summary-pipeline";
import {
  cleanMaterialText as cleanText,
  readMaterialFile,
} from "@/lib/material-readers";

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
const MIN_EXTERNAL_CHARS = 80;
const MIN_LOCAL_CHARS = 500;

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
8. Si el material incluye programa, guía, consignas o exámenes anteriores, identificá qué parece evaluar el curso y citá de dónde surge. Si no existe esa evidencia, decí explícitamente que no se puede saber qué pedirá el docente.

SALIDA
- Ficha del tema
- Idea central
- Resumen organizado por secciones
- Conceptos clave explicados
- Relaciones importantes y comparaciones
- Qué podría evaluarse, únicamente cuando haya evidencia en el material
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
  const [isPackaging, setIsPackaging] = useState(false);
  const [packageMessage, setPackageMessage] = useState("");
  const [packageSnapshot, setPackageSnapshot] = useState<{
    material: string;
    prompt: string;
    destination: string;
  } | null>(null);
  const [useMode, setUseMode] = useState<UseMode | null>(null);
  const [externalProvider, setExternalProvider] = useState<ExternalProvider | null>(null);
  const [showModeChooser, setShowModeChooser] = useState(true);
  const [chooserStep, setChooserStep] = useState<"mode" | "provider" | "about">("mode");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedPackage, setCopiedPackage] = useState(false);
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
  const externalReady = combinedText.length >= MIN_EXTERNAL_CHARS;
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
  const externalMaterialAnalysis = useMemo(
    () => analyzeExternalMaterial(combinedText),
    [combinedText],
  );
  const externalPackagePlan = useMemo(
    () => ({ ...externalMaterialAnalysis, topicMissing: !config.topic.trim() }),
    [config.topic, externalMaterialAnalysis],
  );
  const selectedProvider = externalProvider ? EXTERNAL_PROVIDERS[externalProvider] : null;
  const destinationName =
    useMode === "chatgpt" ? "ChatGPT" : selectedProvider?.name ?? "otra IA";
  const packageSnapshotIsCurrent =
    packageSnapshot?.material === combinedText &&
    packageSnapshot.prompt === promptText &&
    packageSnapshot.destination === destinationName;

  const suggestions = useMemo(() => {
    const items: string[] = [];
    if (!config.topic.trim()) items.push("Escribí el tema: ayuda a no mezclar conceptos cercanos.");
    if (materials.length > 1)
      items.push("Indicá autores o unidades si querés comparar sin mezclar atribuciones.");
    if (useMode === "local" && localSummaryPlan.optimized)
      items.push(
        "Documento enorme: activaremos un modo local compacto para reducir el tiempo. Por capítulos sigue siendo más preciso.",
      );
    if (useMode && useMode !== "local" && externalPackagePlan.shouldSplit)
      items.push(
        `Material enorme: prepararemos ${externalPackagePlan.partCount} partes para no depender de un único contexto.`,
      );
    if (config.focus.length < 2)
      items.push("Elegí al menos dos focos, por ejemplo Conceptos + Relaciones.");
    if (!config.notes.trim())
      items.push("Contá qué te cuesta o qué suele evaluar el docente, si lo sabés.");
    if (!items.length)
      items.push("La configuración está completa. Después revisá el resultado contra el material.");
    return items.slice(0, 3);
  }, [
    config,
    externalPackagePlan.partCount,
    externalPackagePlan.shouldSplit,
    localSummaryPlan.optimized,
    materials.length,
    useMode,
  ]);

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
        const text = await readMaterialFile(file);
        next.push({
          id,
          name: file.name,
          size: file.size,
          text,
          status: text.length >= MIN_EXTERNAL_CHARS ? "ready" : "error",
          note:
            text.length >= MIN_EXTERNAL_CHARS
              ? undefined
              : "El archivo tiene muy poco texto utilizable",
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
    setPackageMessage("");
    setPackageSnapshot(null);
    setCopiedPackage(false);
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
    setPackageMessage("");
    setPackageSnapshot(null);
    setCopiedPackage(false);
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

  function openMethodGuide() {
    setChooserStep("mode");
    setShowModeChooser(false);
    window.setTimeout(
      () => document.querySelector("#metodo")?.scrollIntoView({ behavior: "smooth" }),
      120,
    );
  }

  async function generateIntelligentSummary() {
    setError("");
    setCopied(false);
    setResultMode("summary");
    setResult("");
    setProgressText("");
    setPackageMessage("");
    setProgressPercent(0);
    setElapsedSeconds(0);
    setAverageSectionSeconds(0);
    setCompletedSections(0);
    setTotalSections(0);
    if (combinedText.length < MIN_LOCAL_CHARS) {
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
    try {
      await navigator.clipboard.writeText(text);
      setError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setError("No se pudo copiar al portapapeles. Revisá los permisos del navegador y volvé a intentarlo.");
    }
  }

  async function copyExternalPackage() {
    if (isReading) {
      setError("Esperá a que terminemos de leer los archivos antes de copiar el paquete.");
      return;
    }
    if (!externalReady) {
      setError("Pegá un fragmento o agregá un archivo con texto antes de copiar el paquete.");
      return;
    }
    const packageText = buildExternalPackage(destinationName, promptText, combinedText);
    try {
      await navigator.clipboard.writeText(packageText);
      setError("");
      setCopiedPackage(true);
      setPackageSnapshot({ material: combinedText, prompt: promptText, destination: destinationName });
      setPackageMessage(
        `Paquete completo copiado: instrucción + ${externalPackagePlan.wordCount.toLocaleString("es-UY")} palabras de material. Ahora abrí ${destinationName} y pegalo en el chat.`,
      );
      window.setTimeout(() => setCopiedPackage(false), 1800);
    } catch {
      setCopiedPackage(false);
      setPackageSnapshot(null);
      setPackageMessage("");
      setError(
        `No se pudo copiar el paquete. Usá el botón de descarga y adjuntá el archivo en ${destinationName}.`,
      );
    }
  }

  function downloadResult() {
    if (!result) return;
    const blob = new Blob([result], { type: "text/markdown;charset=utf-8" });
    triggerDownload(
      blob,
      `${(config.topic || "resumen-de-estudio")
        .toLowerCase()
        .replace(/[^a-z0-9áéíóúñ]+/gi, "-")
        .replace(/^-|-$/g, "")}.md`,
    );
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadExternalPackage() {
    if (!externalReady) {
      setError("Pegá un fragmento o agregá un archivo con texto antes de descargar el paquete.");
      return;
    }
    const destination = destinationName;
    const packageText = buildExternalPackage(destination, promptText, combinedText);
    const blob = new Blob([packageText], { type: "text/plain;charset=utf-8" });
    const slug = destination
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ]+/gi, "-")
      .replace(/^-|-$/g, "");
    triggerDownload(blob, `paquete-para-${slug}.txt`);
    setError("");
    setPackageSnapshot({ material: combinedText, prompt: promptText, destination: destinationName });
    setPackageMessage(
      `Paquete completo descargado: instrucción + ${externalPackagePlan.sourceCount} material(es) con ${externalPackagePlan.wordCount.toLocaleString("es-UY")} palabras. Ahora abrí ${destination} y adjuntá el archivo .txt.`,
    );
  }

  async function downloadExternalZip() {
    if (!externalReady) {
      setError("Pegá un fragmento o agregá un archivo con texto antes de descargar el paquete.");
      return;
    }
    setError("");
    setIsPackaging(true);
    setPackageMessage("");
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const parts = splitByStructure(combinedText, 120_000, 0);
      const destination = destinationName;
      const slug = destination
        .toLowerCase()
        .replace(/[^a-z0-9áéíóúñ]+/gi, "-")
        .replace(/^-|-$/g, "");
      const readme = `APUNTE CLARO · PAQUETE DIVIDIDO PARA ${destination.toUpperCase()}

El material es demasiado extenso para depender de una única respuesta.

1. Abrí ${destination}.
2. Adjuntá y procesá las partes en orden, desde 01 hasta ${String(parts.length).padStart(2, "0")}.
3. Guardá cada síntesis parcial.
4. Al terminar, abrí 99-INTEGRAR-RESPUESTAS.txt y pegá allí todas las síntesis.
5. Verificá nombres, autores, páginas, fechas y relaciones contra los archivos originales.

Apunte Claro no envió ningún archivo automáticamente.
`;
      zip.file("00-COMO-USAR.txt", readme);
      zip.file("00-INSTRUCCION-ACADEMICA.txt", promptText);
      parts.forEach((part, index) => {
        zip.file(
          `${String(index + 1).padStart(2, "0")}-PARTE-DE-ESTUDIO.txt`,
          buildExternalPartPackage(destination, promptText, part, index + 1, parts.length),
        );
      });
      zip.file(
        "99-INTEGRAR-RESPUESTAS.txt",
        buildExternalIntegrationPrompt(destination, parts.length),
      );
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      triggerDownload(blob, `paquete-dividido-para-${slug}.zip`);
      setPackageMessage(
        `Paquete dividido descargado: ${parts.length} partes numeradas + instrucción de integración final. Abrí ${destination} y seguí 00-COMO-USAR.txt para enviarlas en orden.`,
      );
      setPackageSnapshot({ material: combinedText, prompt: promptText, destination: destinationName });
    } catch {
      setError("No se pudo crear el ZIP. Podés descargar todo en un único archivo .txt.");
    } finally {
      setIsPackaging(false);
    }
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
                  <span className="mode-kicker">Gratis · sin cuenta en Apunte Claro</span>
                  <h2 id="mode-title">¿Cómo querés preparar tu resumen?</h2>
                  <p id="mode-description">
                    Organizamos el material y el pedido académico. Después vos elegís dónde procesarlo.
                  </p>
                </div>

                <div className="mode-direct-start">
                  <div>
                    <span className="mode-kicker">Opción directa</span>
                    <strong>Prepará tu paquete para ChatGPT</strong>
                    <p>Agregá tus apuntes y decidí cuándo compartir el paquete.</p>
                  </div>
                  <button type="button" className="primary-button" onClick={() => chooseMode("chatgpt")}>
                    Empezar con ChatGPT <span aria-hidden="true">→</span>
                  </button>
                </div>

                <div className="mode-options">
                  <button
                    type="button"
                    className="mode-option"
                    onClick={() => setChooserStep("provider")}
                  >
                    <span className="mode-icon" aria-hidden="true">✦</span>
                    <span className="mode-option-copy">
                      <strong>Elegir otra IA</strong>
                      <small>Gemini, Copilot, Claude y más</small>
                      <span>Preparamos el pedido y el material para la herramienta que elijas.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>

                  <button type="button" className="mode-option mode-option-local" onClick={() => chooseMode("local")}>
                    <span className="mode-icon" aria-hidden="true">⌁</span>
                    <span className="mode-option-copy">
                      <strong>Generar en mi computadora</strong>
                      <small>Más privado · bastante más lento</small>
                      <span>Usa la IA local de Chrome. Es opcional y puede tardar con materiales grandes.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>

                  <button type="button" className="mode-option" onClick={openMethodGuide}>
                    <span className="mode-icon" aria-hidden="true">?</span>
                    <span className="mode-option-copy">
                      <strong>Aprender el método</strong>
                      <small>Qué hace bueno a un resumen</small>
                      <span>Leé cómo seleccionar, conectar y revisar ideas antes de usar cualquier IA.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>
                </div>

                <p className="mode-privacy">
                  Apunte Claro no pide cuenta ni envía tus archivos. La herramienta externa puede
                  solicitar registro y aplica sus propias condiciones.
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
                  <span className="mode-kicker">Camino recomendado</span>
                  <h2 id="mode-title">Elegí la IA que prefieras</h2>
                  <p id="mode-description">
                    No conectamos cuentas ni pedimos claves. Preparamos un archivo para que vos lo lleves.
                  </p>
                </div>

                <div className="mode-options provider-options">
                  <button
                    type="button"
                    className="mode-option provider-option"
                    onClick={() => chooseMode("chatgpt")}
                  >
                    <span className="mode-icon provider-icon" aria-hidden="true">✦</span>
                    <span className="mode-option-copy">
                      <strong>ChatGPT</strong>
                      <span>Prepará un paquete académico y abrilo después en ChatGPT.</span>
                    </span>
                    <span className="mode-arrow" aria-hidden="true">→</span>
                  </button>
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
                    Porque Apunte Claro organiza el material y construye el pedido en tu navegador.
                    No cobra por una IA propia ni envía archivos a un servidor.
                  </p>
                </div>

                <div className="about-grid">
                  <article>
                    <span className="about-number">01</span>
                    <h3>Prepara, no encierra</h3>
                    <p>
                      Convierte tus opciones de estudio en una instrucción precisa y agrega el
                      material completo para usarlo en la herramienta que elijas.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">02</span>
                    <h3>Vos elegís la IA</h3>
                    <p>
                      ChatGPT, Gemini, Claude, Copilot u otra plataforma procesan el paquete sólo
                      cuando vos decidís copiarlo o adjuntarlo.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">03</span>
                    <h3>Nada se envía solo</h3>
                    <p>
                      La lectura y preparación ocurren en tu navegador. Cada plataforma externa
                      tiene sus propias cuentas, límites y políticas de privacidad.
                    </p>
                  </article>
                  <article>
                    <span className="about-number">04</span>
                    <h3>La opción local sigue disponible</h3>
                    <p>
                      Chrome puede usar Gemini Nano en equipos compatibles. Es la alternativa más
                      privada, aunque puede tardar bastante y tiene menos contexto.
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
          <a href="#metodo">Método y revisión</a>
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
          <span className="eyebrow">Un método de estudio para usar con la IA que prefieras</span>
          <h1>
            No le pidas a una IA “resumime esto”.
            <span> Pedile un resumen que sirva para estudiar.</span>
          </h1>
          <p>
            Apunte Claro organiza tus materiales, tu objetivo y lo que necesitás aprender.
            Después prepara un paquete preciso para ChatGPT, Gemini, Claude, Copilot u otra IA.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#crear">
              Preparar mi resumen <span aria-hidden="true">→</span>
            </a>
            <button type="button" className="text-link" onClick={openFreeInfo}>
              ¿Por qué es gratuito?
            </button>
          </div>
          <div className="trust-row">
            <span><AppIcon>✓</AppIcon> Sin cuenta en Apunte Claro</span>
            <span><AppIcon>✓</AppIcon> Elegís la IA</span>
            <span><AppIcon>✓</AppIcon> Nada se envía solo</span>
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
          <h2>Prepará un buen resumen en tres pasos</h2>
          <p>Combiná materiales, definí qué necesitás y llevate un paquete listo para la IA elegida.</p>
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
                  {!combinedText
                    ? "agregá material para comenzar"
                    : useMode === "local"
                      ? `estimación inicial: ${estimatedSections} secciones`
                      : !externalReady
                        ? "fragmento muy breve: agregá un poco más"
                        : externalPackagePlan.shouldSplit
                          ? `paquete recomendado: ${externalPackagePlan.partCount} partes`
                          : "listo para un paquete completo"}
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
                <span className="field-label">Qué te cuesta o qué suele evaluar el docente</span>
                <textarea
                  value={config.notes}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Ej. Me confundo entre dos autores. En los parciales suelen pedir comparaciones y ejemplos."
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
                  <h3>
                    {useMode === "local"
                      ? "Generá en tu computadora"
                      : `Prepará para ${destinationName}`}
                  </h3>
                  <p>
                    {useMode === "local"
                      ? "Alternativa privada: funciona en Chrome, pero puede tardar."
                      : "Armamos el pedido; vos decidís cuándo y dónde compartirlo."}
                  </p>
                </div>
              </div>

              {useMode === "local" ? (
                <div className="selected-mode-banner local-alternative">
                  <span aria-hidden="true">⌁</span>
                  <div>
                    <strong>Generación local opcional</strong>
                    <small>Más privada, pero puede ser muy lenta con documentos grandes.</small>
                  </div>
                  <button type="button" onClick={() => {
                    setChooserStep("provider");
                    setShowModeChooser(true);
                  }}>
                    Usar otra IA
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
                <>
                  <div className="package-readiness">
                    <div className="package-readiness-heading">
                      <div>
                        <span>Paquete académico</span>
                        <strong>
                          {!externalReady
                            ? "Pegá un fragmento o agregá un archivo"
                            : `Listo para copiar o descargar y usar en ${destinationName}`}
                        </strong>
                      </div>
                      {externalReady && (
                        <span className="package-kind">
                          {externalPackagePlan.shouldSplit
                            ? `${externalPackagePlan.partCount} partes`
                            : "Paquete único"}
                        </span>
                      )}
                    </div>
                    <div className="package-stats" aria-label="Contenido del paquete">
                      <span>
                        <strong>{externalPackagePlan.sourceCount}</strong>
                        materiales
                      </span>
                      <span>
                        <strong>{externalPackagePlan.pageCount || "—"}</strong>
                        {externalPackagePlan.pageCount ? "páginas" : "sin páginas"}
                      </span>
                      <span>
                        <strong>{externalPackagePlan.wordCount.toLocaleString("es-UY")}</strong>
                        palabras
                      </span>
                    </div>
                    {externalReady && (
                      <div className="package-checks">
                        <p className={externalPackagePlan.topicMissing ? "is-warning" : "is-ready"}>
                          <span>{externalPackagePlan.topicMissing ? "!" : "✓"}</span>
                          {externalPackagePlan.topicMissing
                            ? "Falta completar el tema: la IA tendrá que inferirlo y confirmarlo."
                            : `Tema declarado: ${config.topic}.`}
                        </p>
                        <p className={externalPackagePlan.assessmentEvidence ? "is-ready" : "is-neutral"}>
                          <span>{externalPackagePlan.assessmentEvidence ? "✓" : "i"}</span>
                          {externalPackagePlan.assessmentEvidence
                            ? "Encontramos posible evidencia de programa, guía o examen para orientar qué podría evaluarse."
                            : "No encontramos evidencia sobre qué pide el docente; el paquete le prohíbe a la IA inventarlo."}
                        </p>
                        <p className={externalPackagePlan.pageCount ? "is-ready" : "is-neutral"}>
                          <span>{externalPackagePlan.pageCount ? "✓" : "i"}</span>
                          {externalPackagePlan.pageCount
                            ? "Las referencias de página quedan dentro del material para poder verificar."
                            : "El material no tiene páginas detectables; se conservarán fuentes y secciones."}
                        </p>
                        {externalPackagePlan.shouldSplit && (
                          <p className="is-ready">
                            <span>✓</span>
                            Es un material enorme: el ZIP incluirá partes numeradas y una instrucción de integración final.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="external-howto">
                    <strong>Qué tenés que hacer</strong>
                    <p className="external-package-explainer">
                      El paquete completo une la instrucción de estudio con el texto extraído de
                      los materiales que agregaste. Está preparado para pegarlo en {destinationName}
                      {" "}o descargarlo y adjuntarlo allí.
                    </p>
                    <ol>
                      <li><span>1</span> Revisá las alertas y completá lo que conozcas.</li>
                      <li>
                        <span>2</span>
                        {externalPackagePlan.shouldSplit
                          ? ` Copiá el paquete completo o descargá el ZIP con sus ${externalPackagePlan.partCount} partes numeradas.`
                          : " Copiá el paquete completo: incluye la instrucción y el texto de tu material."}
                      </li>
                      <li>
                        <span>3</span> Abrí {destinationName} y pegalo en el chat. Si lo descargaste,
                        adjuntá el archivo. Apunte Claro nunca lo envía por vos.
                      </li>
                    </ol>
                  </div>
                </>
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
                <div className="prompt-preview">
                  <span>Vista previa de la instrucción · el paquete completo también incluye tu material</span>
                  <article className="result-output prompt-output">
                    <pre>{promptText}</pre>
                  </article>
                </div>
              )}

              {progressText && useMode === "local" && (
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
              {packageSnapshotIsCurrent && packageMessage && useMode && useMode !== "local" && (
                <div className="package-success" role="status">
                  <span>✓</span>
                  {packageMessage}
                </div>
              )}
              {error && <div className="error-message" role="alert">{error}</div>}

              <div className="result-actions">
                {useMode && useMode !== "local" ? (
                  <>
                    <button
                      type="button"
                      className="primary-button generate-button copy-package-button"
                      disabled={isReading || !externalReady}
                      onClick={copyExternalPackage}
                    >
                      {packageSnapshotIsCurrent && copiedPackage
                        ? "Paquete completo copiado ✓"
                        : "Copiar paquete completo"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={isReading || isPackaging || !externalReady}
                      onClick={
                        externalPackagePlan.shouldSplit
                          ? downloadExternalZip
                          : downloadExternalPackage
                      }
                    >
                      {isPackaging
                        ? "Armando el paquete…"
                        : externalPackagePlan.shouldSplit
                          ? `Descargar ${externalPackagePlan.partCount} partes (.zip)`
                          : "Descargar paquete (.txt)"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="primary-button generate-button"
                    disabled={isGenerating || isReading}
                    onClick={generateIntelligentSummary}
                  >
                    {isGenerating ? "Trabajando por secciones…" : "Probar generación local"}
                  </button>
                )}
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
                      ? "Copiar sólo la instrucción"
                      : "Copiar"}
                </button>
                {resultMode === "summary" && result && (
                  <button type="button" className="secondary-button" onClick={downloadResult}>
                    Descargar .md
                  </button>
                )}
                {useMode && useMode !== "local" && externalPackagePlan.shouldSplit && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!externalReady}
                    onClick={downloadExternalPackage}
                  >
                    Descargar todo junto (.txt)
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
          <h2>La calidad no depende solamente de la IA</h2>
          <p>Apunte Claro convierte criterios de estudio en un pedido preciso y una revisión verificable.</p>
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

        <aside className="purpose-note" aria-labelledby="purpose-title">
          <div>
            <span className="step-kicker">Por qué existe Apunte Claro</span>
            <h3 id="purpose-title">Estudiar mejor debería estar al alcance de cualquiera.</h3>
          </div>
          <div>
            <p>
              Preparar una buena síntesis requiere lectura, criterio y trabajo. Apunte Claro no
              busca desvalorizar ese esfuerzo ni reemplazar el estudio: ayuda a que cualquier
              estudiante pueda aprender a construir un resumen cuidadoso y metódico, usando su
              propio material y revisando críticamente lo que produce la IA.
            </p>
            <strong>No te entrega una respuesta para repetir: te ayuda a organizar, comprender y revisar.</strong>
          </div>
        </aside>

        <div className="quality-panel">
          <div className="quality-heading">
            <span className="step-kicker">Después de recibirlo</span>
            <h3>Cuatro controles antes de estudiar el resumen</h3>
            <p>Una respuesta prolija puede ser incorrecta. Revisala con estas preguntas.</p>
          </div>
          <div className="quality-grid">
            <article>
              <strong>01 · Atribuciones</strong>
              <p>¿Cada concepto está asociado al autor que realmente lo propone?</p>
            </article>
            <article>
              <strong>02 · Relaciones</strong>
              <p>¿Explica por qué las ideas se conectan o sólo las enumera?</p>
            </article>
            <article>
              <strong>03 · Evidencia</strong>
              <p>¿Podés volver a la página o sección original para verificarlo?</p>
            </article>
            <article>
              <strong>04 · Utilidad</strong>
              <p>¿Podés explicarlo con tus palabras y responder preguntas sin mirar?</p>
            </article>
          </div>
          <p className="quality-warning">
            Si no sabés qué “pide el docente”, agregá el programa, una guía o exámenes anteriores.
            La IA puede detectar temas importantes, pero no adivinar criterios que no aparecen en el material.
          </p>
        </div>
      </section>

      <section className="privacy-section" id="privacidad">
        <div className="privacy-copy">
          <span className="step-kicker">Control en manos del estudiante</span>
          <h2>Apunte Claro no necesita cuenta y nunca envía tus archivos solo.</h2>
          <p>
            La preparación se realiza en el navegador. Si elegís una IA externa, compartís el
            paquete recién cuando vos lo adjuntás allí y se aplican las condiciones de esa plataforma.
            También podés probar Gemini Nano local en Chrome compatible: es más privado, pero más lento.
          </p>
        </div>
        <div className="privacy-facts">
          <div><strong>Sin registro propio</strong><span>Apunte Claro no crea perfiles</span></div>
          <div><strong>Elección clara</strong><span>vos decidís qué IA utilizar</span></div>
          <div><strong>Revisión humana</strong><span>la respuesta siempre debe verificarse</span></div>
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
