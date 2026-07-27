import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1")
    ? "http"
    : "https";
  const imageUrl = `${protocol}://${host}/og.png`;
  const title = "Apunte Claro · Resúmenes inteligentes para estudiar";
  const description =
    "Convertí apuntes y textos universitarios en resúmenes de estudio con IA local, sin cuenta ni API.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      locale: "es_UY",
      images: [{ url: imageUrl, width: 1732, height: 908, alt: "Apunte Claro" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
