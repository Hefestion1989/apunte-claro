import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished Apunte Claro page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Apunte Claro · Resúmenes inteligentes para estudiar<\/title>/i);
  assert.match(html, /Pedile un resumen que sirva para estudiar/);
  assert.match(html, /Preparar mi resumen/);
  assert.match(html, /Sin cuenta en Apunte Claro/);
  assert.match(html, /Elegís la IA/);
  assert.match(html, /¿Cómo querés preparar tu resumen\?/);
  assert.match(html, /Empezar con ChatGPT/);
  assert.match(html, /Elegir otra IA/);
  assert.match(html, /Generar en mi computadora/);
  assert.match(html, /Aprender el método/);
  assert.match(html, /Apunte Claro no pide cuenta ni envía tus archivos/);
  assert.match(html, /Cuatro controles antes de estudiar el resumen/);
  assert.match(html, /https:\/\/www\.educalive\.com\/blog\/como-hacer-resumen/);
  assert.match(html, /https:\/\/help\.openai\.com\/en\/articles\/9125172-the-chatgpt-home-page/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("keeps summarization local and includes supported material readers", async () => {
  const [page, layout, packageJson, materialReaders] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/material-readers.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Summarizer\.availability/);
  assert.doesNotMatch(page, /LanguageModel\.create|LanguageModel\.availability/);
  assert.doesNotMatch(page, /Dándole estructura académica/);
  assert.match(page, /splitByStructure/);
  assert.match(page, /measureInputUsage/);
  assert.match(materialReaders, /pdfjs-dist/);
  assert.match(materialReaders, /mammoth/);
  assert.match(materialReaders, /extractRtfText/);
  assert.match(materialReaders, /readMaterialFile/);
  assert.match(page, /MIN_EXTERNAL_CHARS = 80/);
  assert.match(page, /MIN_LOCAL_CHARS = 500/);
  assert.match(page, /downloadExternalPackage/);
  assert.match(page, /downloadExternalZip/);
  assert.match(page, /analyzeExternalMaterial/);
  assert.match(page, /buildExternalIntegrationPrompt/);
  assert.match(page, /buildPartialSummary/);
  assert.match(page, /Detener y conservar/);
  assert.match(page, /MAX_LOCAL_CHARS/);
  assert.match(page, /Gemini Nano/);
  assert.match(page, /¿Por qué puede ser gratis\?/);
  assert.match(page, /chrome:\/\/on-device-internals/);
  assert.match(page, /splitByStructure\(combinedText, generationPlan\.chunkChars, 0\)/);
  assert.match(page, /localSummaryPlan\.chunkChars/);
  assert.match(page, /No arrastres temas de otra sección/);
  assert.match(page, /No conviertas bibliografías, índices, carátulas/);
  assert.match(page, /buildLocalSummaryPlan/);
  assert.match(page, /Modo compacto activo/);
  assert.match(page, /sectionDurations\.slice\(-3\)/);
  assert.doesNotMatch(page, /await fitChunksToQuota/);
  assert.match(page, /isIncompleteSummary/);
  assert.match(page, /buildSectionLabels/);
  assert.match(page, /Recorrido fiel por secciones/);
  assert.match(page, /tiempo muestra lo realmente transcurrido/);
  assert.match(page, /Tiempo restante estimado/);
  assert.match(page, /https:\/\/chatgpt\.com\//);
  assert.match(page, /https:\/\/gemini\.google\.com\//);
  assert.match(page, /https:\/\/claude\.ai\//);
  assert.match(page, /https:\/\/copilot\.microsoft\.com\//);
  assert.match(page, /Descargar todo junto \(\.txt\)/);
  assert.match(page, /Copiar paquete completo/);
  assert.match(page, /Copiar sólo la instrucción/);
  assert.match(page, /el paquete completo también incluye tu material/);
  assert.match(page, /El paquete completo une la instrucción de estudio con el texto extraído/);
  assert.match(page, /\{" "\}o descargarlo y adjuntarlo allí/);
  assert.match(page, /Estudiar mejor debería estar al alcance de cualquiera/);
  assert.match(page, /resumen cuidadoso y metódico/);
  assert.match(page, /No te entrega una respuesta para repetir/);
  assert.ok(
    page.indexOf("Copiar paquete completo") < page.indexOf("Copiar sólo la instrucción"),
    "la acción completa debe aparecer antes que la opción avanzada",
  );
  assert.match(page, /Paquete académico/);
  assert.match(page, /No encontramos evidencia sobre qué pide el docente/);
  assert.doesNotMatch(page, /prepareExternalPackage/);
  assert.doesNotMatch(page, /combinedText\.length < 500/);
  assert.doesNotMatch(page, /\.slice\(0,\s*MAX_TOTAL_CHARS\)/);
  assert.doesNotMatch(page, /primeros 280\.000 caracteres/);
  assert.doesNotMatch(page, /OPENAI_API_KEY|GEMINI_API_KEY|fetch\(["']https:\/\/api\./);
  assert.match(layout, /og-study-method\.png/);
  assert.match(packageJson, /"next": "16\.2\.12"/);
  assert.match(packageJson, /"jszip": "\^3\.10\.1"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(
    access(new URL("../app/_sites-preview/preview.css", import.meta.url)),
  );
});
