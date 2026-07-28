import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeExternalMaterial,
  buildExternalPackage,
  buildExternalIntegrationPrompt,
  buildExternalPartPackage,
  buildIntegrationSource,
  buildLocalSummaryPlan,
  buildPartialSummary,
  buildSectionLabels,
  extractRtfText,
  fitChunksToQuota,
  isIncompleteSummary,
  runSectionSummaries,
  splitByStructure,
  SummaryCancelled,
} from "../lib/summary-pipeline.ts";

function buildLargeAcademicFixture(sectionCount = 60) {
  return Array.from({ length: sectionCount }, (_, index) => {
    const marker = `SECCION_${String(index + 1).padStart(3, "0")}`;
    const body =
      "La psicología estudia procesos, conceptos, relaciones y evidencias dentro de contextos históricos y sociales. ".repeat(
        62,
      );
    return `## ${marker}\n\n${body}\n\nMARCADOR_${marker}`;
  }).join("\n\n");
}

test("plans a document larger than the former limit without losing its ending", () => {
  const material = buildLargeAcademicFixture();
  assert.ok(material.length > 280_000);

  const chunks = splitByStructure(material, 16_000, 0);
  assert.ok(chunks.length > 10);
  assert.match(chunks[0], /SECCION_001/);
  assert.match(chunks.at(-1) ?? "", /MARCADOR_SECCION_060/);
  assert.equal(chunks.some((chunk) => chunk.length > 16_000), false);
});

test("keeps the full long document in packages for external tools", () => {
  const material = buildLargeAcademicFixture();
  const packageText = buildExternalPackage("Gemini", "Resumí con rigor.", material);

  assert.ok(packageText.length > 280_000);
  assert.match(packageText, /SECCION_001/);
  assert.match(packageText, /MARCADOR_SECCION_060/);
});

test("audits external material before packaging it", () => {
  const material = `===== FUENTE: Guía de parcial.pdf =====

[Página 1]
Consignas de parcial sobre autores y conceptos.

[Página 2]
Comparar las teorías principales.`;
  const plan = analyzeExternalMaterial(material);

  assert.equal(plan.sourceCount, 1);
  assert.equal(plan.pageCount, 2);
  assert.equal(plan.assessmentEvidence, true);
  assert.equal(plan.shouldSplit, false);
});

test("plans numbered external parts and a final integration instruction", () => {
  const largeMaterial = `===== TEXTO PEGADO =====\n\n${"Concepto relacionado con un autor. ".repeat(35_000)}`;
  const plan = analyzeExternalMaterial(largeMaterial);
  const firstPart = buildExternalPartPackage(
    "Gemini",
    "Resumí con precisión.",
    "Fragmento académico.",
    1,
    plan.partCount,
  );
  const integration = buildExternalIntegrationPrompt("Gemini", plan.partCount);

  assert.equal(plan.sourceCount, 1);
  assert.equal(plan.shouldSplit, true);
  assert.ok(plan.partCount > 1);
  assert.match(firstPart, /parte 1 de \d+/);
  assert.match(firstPart, /No presentes todavía una conclusión general/);
  assert.match(integration, /Integración final para Gemini/);
  assert.match(integration, /No agregues conocimiento externo/);
});

test("extracts readable Spanish text from formatted RTF", () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0 Arial;}{\f1 Times New Roman;}}
{\colortbl;\red0\green0\blue0;}
\viewkind4\uc1\pard
\b Dispositivos psicoterap\u233?uticos\b0\par
Freud propuso una relaci\u243?n entre cl\u237?nica y teor\u237?a.\par
Autor:\tab Michel Foucault.\line Cr\'edtica y comparaci\'f3n.\par
}`;
  const text = extractRtfText(rtf);

  assert.match(text, /Dispositivos psicoterapéuticos/);
  assert.match(text, /relación entre clínica y teoría/);
  assert.match(text, /Michel Foucault/);
  assert.match(text, /Crítica y comparación/);
  assert.doesNotMatch(text, /fonttbl|Arial|colortbl|\\par|\\u233/);
});

test("publishes a readable partial draft after every completed section", async () => {
  const seen = [];
  const chunks = ["memoria", "aprendizaje", "percepción"];

  const result = await runSectionSummaries({
    chunks,
    summarize: async (chunk, index) => `Síntesis ${index + 1}: ${chunk}`,
    onProgress(progress) {
      seen.push(
        buildPartialSummary(progress.partials, progress.total, "Psicología"),
      );
    },
  });

  assert.equal(seen.length, 3);
  assert.match(seen[0], /1 de 3 secciones procesadas/);
  assert.match(seen[0], /Síntesis 1: memoria/);
  assert.doesNotMatch(seen[0], /Síntesis 2/);
  assert.deepEqual(result, [
    "Síntesis 1: memoria",
    "Síntesis 2: aprendizaje",
    "Síntesis 3: percepción",
  ]);
});

test("labels summaries with the source and PDF page range", () => {
  const chunks = [
    "===== FUENTE: Psicología.pdf =====\n\n[Página 1]\nIntroducción\n\n[Página 2]\nConceptos",
    "[Página 3]\nAutores\n\n[Página 4]\nRelaciones",
    "===== FUENTE: Notas.md =====\n\nTexto sin páginas",
  ];

  assert.deepEqual(buildSectionLabels(chunks), [
    "Psicología.pdf · páginas 1–2",
    "Psicología.pdf · páginas 3–4",
    "Notas.md",
  ]);
});

test("uses traceable labels in partial summaries", () => {
  const draft = buildPartialSummary(
    ["Síntesis verificable."],
    1,
    "Psicología",
    "working",
    ["Dispositivos.pdf · páginas 7–9"],
  );

  assert.match(draft, /### Dispositivos\.pdf · páginas 7–9/);
  assert.doesNotMatch(draft, /### Sección 1/);
});

test("uses a compact one-pass plan for enormous local documents", () => {
  const plan = buildLocalSummaryPlan(45_000, "medium");

  assert.equal(plan.optimized, true);
  assert.equal(plan.chunkChars, 24_000);
  assert.equal(plan.sectionType, "key-points");
  assert.equal(plan.sectionFormat, "markdown");
  assert.equal(plan.sectionLength, "medium");
  assert.equal(plan.preference, "auto");
  assert.equal(plan.retryIncomplete, false);
  assert.equal(plan.includeIntegratedKeyPoints, false);
});

test("keeps the detailed plan for ordinary documents", () => {
  const plan = buildLocalSummaryPlan(8_000, "long");

  assert.equal(plan.optimized, false);
  assert.equal(plan.chunkChars, 16_000);
  assert.equal(plan.sectionType, "tldr");
  assert.equal(plan.sectionLength, "long");
  assert.equal(plan.preference, "capability");
  assert.equal(plan.retryIncomplete, true);
  assert.equal(plan.includeIntegratedKeyPoints, true);
});

test("builds a small integration source without deleting the detailed sections", () => {
  const partials = [
    "Primera idea. Segunda relación. Tercer detalle.",
    "- Autor A formula una tesis. Autor B la critica. Ejemplo secundario.",
  ];

  const integration = buildIntegrationSource(partials, 2);
  assert.equal(
    integration,
    "Primera idea. Segunda relación.\n\nAutor A formula una tesis. Autor B la critica.",
  );
  assert.equal(partials[0], "Primera idea. Segunda relación. Tercer detalle.");
});

test("cancels before the next section and preserves completed summaries", async () => {
  const controller = new AbortController();
  const started = [];

  await assert.rejects(
    runSectionSummaries({
      chunks: ["uno", "dos", "tres", "cuatro"],
      signal: controller.signal,
      async summarize(chunk, index) {
        started.push(chunk);
        if (index === 1) controller.abort();
        return `Parcial ${index + 1}`;
      },
    }),
    (error) => {
      assert.ok(error instanceof SummaryCancelled);
      assert.deepEqual(error.partials, ["Parcial 1", "Parcial 2"]);
      assert.equal(error.total, 4);
      return true;
    },
  );

  assert.deepEqual(started, ["uno", "dos"]);
});

test("recovers from a failed section without deleting earlier work", async () => {
  const progress = [];
  const result = await runSectionSummaries({
    chunks: ["autores", "teorías", "fechas"],
    async summarize(chunk, index) {
      if (index === 1) throw new Error("fallo simulado");
      return `IA: ${chunk}`;
    },
    recover: async (_error, chunk) => `Respaldo: ${chunk}`,
    onProgress(value) {
      progress.push(value.completed);
    },
  });

  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(result, ["IA: autores", "Respaldo: teorías", "IA: fechas"]);
});

test("splits a pathological long block until every call fits the quota", async () => {
  const source = `INICIO_${"x".repeat(49_980)}_FINAL`;
  const fitted = await fitChunksToQuota(
    splitByStructure(source, 16_000, 0),
    async (chunk) => chunk.length,
    2_000,
  );

  assert.ok(fitted.length > 20);
  assert.equal(fitted.every((chunk) => chunk.length <= 2_000), true);
  assert.match(fitted[0], /INICIO/);
  assert.match(fitted.at(-1) ?? "", /FINAL/);
});

test("does not create orphan overlap chunks or exceed the requested size", () => {
  const source = `${"a".repeat(16_000)}\n\n${"b".repeat(16_000)}`;
  const chunks = splitByStructure(source, 16_000, 240);

  assert.deepEqual(chunks.map((chunk) => chunk.length), [16_000, 16_000]);
  assert.equal(chunks.some((chunk) => chunk.length === 240), false);
  assert.equal(chunks.every((chunk) => chunk.length <= 16_000), true);
});

test("keeps splitting until every measurable chunk fits a small quota", async () => {
  const fitted = await fitChunksToQuota(
    splitByStructure(`${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`, 1_200, 0),
    async (chunk) => chunk.length,
    1_000,
  );

  assert.equal(fitted.every((chunk) => chunk.length <= 1_000), true);
  assert.equal(fitted.join(""), `${"a".repeat(1_200)}${"b".repeat(1_200)}`);
});

test("detects summaries cut off by the local model", () => {
  assert.equal(
    isIncompleteSummary("En la fase actual, los dispositivos producen procesos que..."),
    true,
  );
  assert.equal(isIncompleteSummary("Agamben denomina desubjetivación a ese proceso."), false);
});

test("can disable overlap so adjacent academic topics do not contaminate each other", () => {
  const agamben = `AGAMBEN_${"a".repeat(1_190)}`;
  const freud = `FREUD_${"f".repeat(1_192)}`;
  const chunks = splitByStructure(`${agamben}\n\n${freud}`, 1_200, 0);

  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /^AGAMBEN_/);
  assert.doesNotMatch(chunks[0], /FREUD_/);
  assert.match(chunks[1], /^FREUD_/);
  assert.doesNotMatch(chunks[1], /AGAMBEN_/);
});
