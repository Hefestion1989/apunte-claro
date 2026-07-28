import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalPackage,
  buildPartialSummary,
  fitChunksToQuota,
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
