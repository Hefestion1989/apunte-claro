import { extractRtfText } from "./summary-pipeline.ts";

export type SupportedMaterialExtension = "pdf" | "docx" | "txt" | "md" | "csv" | "rtf";

export function cleanMaterialText(text: string) {
  return text
    .split("\u0000")
    .join("")
    .replace(/Encuentre más documentos universitarios en https?:\/\/apunty\.com/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export async function readPdfData(data: Uint8Array) {
  const pdfjs =
    typeof window === "undefined"
      ? await import("pdfjs-dist/legacy/build/pdf.mjs")
      : await import("pdfjs-dist");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }
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
  return cleanMaterialText(pages.join("\n\n"));
}

export async function readDocxData(arrayBuffer: ArrayBuffer) {
  const mammoth = await import("mammoth");
  const input =
    typeof window === "undefined"
      ? { buffer: new Uint8Array(arrayBuffer) }
      : { arrayBuffer };
  const result = await mammoth.extractRawText(
    input as Parameters<typeof mammoth.extractRawText>[0],
  );
  return cleanMaterialText(result.value);
}

export function readTextData(text: string, extension: SupportedMaterialExtension) {
  return cleanMaterialText(extension === "rtf" ? extractRtfText(text) : text);
}

export async function readMaterialFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() as
    | SupportedMaterialExtension
    | undefined;
  if (extension === "pdf") return readPdfData(new Uint8Array(await file.arrayBuffer()));
  if (extension === "docx") return readDocxData(await file.arrayBuffer());
  if (extension && ["txt", "md", "csv", "rtf"].includes(extension)) {
    return readTextData(await file.text(), extension);
  }
  throw new Error("Formato no compatible");
}
