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
  assert.match(html, /De textos enormes a un/);
  assert.match(html, /Generar resumen inteligente/);
  assert.match(html, /Sin cuenta/);
  assert.match(html, /Sin API/);
  assert.match(html, /Elegí cómo querés resumir/);
  assert.match(html, /IA local · sin cuenta/);
  assert.match(html, /Usar ChatGPT/);
  assert.match(html, /Elegir otra IA/);
  assert.match(html, /Gemini, Copilot, Claude u otra/);
  assert.match(html, /No necesitás entender de IA/);
  assert.match(html, /Apunte Claro no pide cuenta ni envía nada por su cuenta/);
  assert.match(html, /https:\/\/www\.educalive\.com\/blog\/como-hacer-resumen/);
  assert.match(html, /https:\/\/help\.openai\.com\/en\/articles\/9125172-the-chatgpt-home-page/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("keeps summarization local and includes supported material readers", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Summarizer\.availability/);
  assert.match(page, /LanguageModel\.availability/);
  assert.match(page, /splitByStructure/);
  assert.match(page, /measureInputUsage/);
  assert.match(page, /pdfjs-dist/);
  assert.match(page, /mammoth/);
  assert.match(page, /downloadExternalPackage/);
  assert.match(page, /buildPartialSummary/);
  assert.match(page, /Detener y conservar/);
  assert.match(page, /MAX_LOCAL_CHARS/);
  assert.match(page, /https:\/\/chatgpt\.com\//);
  assert.match(page, /https:\/\/gemini\.google\.com\//);
  assert.match(page, /https:\/\/claude\.ai\//);
  assert.match(page, /https:\/\/copilot\.microsoft\.com\//);
  assert.match(page, /Descargar paquete \.txt/);
  assert.doesNotMatch(page, /\.slice\(0,\s*MAX_TOTAL_CHARS\)/);
  assert.doesNotMatch(page, /primeros 280\.000 caracteres/);
  assert.doesNotMatch(page, /OPENAI_API_KEY|GEMINI_API_KEY|fetch\(["']https:\/\/api\./);
  assert.match(layout, /og\.png/);
  assert.match(packageJson, /"next": "16\.2\.12"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(
    access(new URL("../app/_sites-preview/preview.css", import.meta.url)),
  );
});
