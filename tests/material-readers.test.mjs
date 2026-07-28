import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { readMaterialFile } from "../lib/material-readers.ts";

function createMinimalPdf(text) {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "binary"));
}

async function createMinimalDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

test("extracts study text from a real PDF container", async () => {
  const file = new File(
    [createMinimalPdf("Autor y concepto en material PDF")],
    "apunte.pdf",
    { type: "application/pdf" },
  );
  const text = await readMaterialFile(file);

  assert.match(text, /\[Página 1\]/);
  assert.match(text, /Autor y concepto en material PDF/);
});

test("extracts study text from a real DOCX container", async () => {
  const file = new File(
    [await createMinimalDocx("Teoría y relación entre autores")],
    "apunte.docx",
    {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  );
  const text = await readMaterialFile(file);

  assert.match(text, /Teoría y relación entre autores/);
  assert.doesNotMatch(text, /w:document|Content_Types/);
});

test("extracts clean TXT, Markdown and CSV text", async () => {
  const cases = [
    ["apunte.txt", "Concepto principal y definición.", /Concepto principal/],
    ["apunte.md", "# Autor\n\nRelación entre ideas.", /Relación entre ideas/],
    ["apunte.csv", "autor,concepto\nFreud,inconsciente", /Freud,inconsciente/],
  ];

  for (const [name, content, expected] of cases) {
    const text = await readMaterialFile(new File([content], name, { type: "text/plain" }));
    assert.match(text, expected);
  }
});

test("extracts accented text from RTF without formatting controls", async () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0 Arial;}}
\viewkind4\uc1\pard\b Psicolog\u237?a\b0\par
Relaci\u243?n entre autor y teor\u237?a.\par Cr\'edtica principal.\par}`;
  const text = await readMaterialFile(
    new File([rtf], "apunte.rtf", { type: "application/rtf" }),
  );

  assert.match(text, /Psicología/);
  assert.match(text, /Relación entre autor y teoría/);
  assert.match(text, /Crítica principal/);
  assert.doesNotMatch(text, /fonttbl|Arial|\\par|\\u237/);
});
