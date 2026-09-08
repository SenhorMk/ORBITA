import type { Metadata } from "next";
import { Archivo, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

/**
 * As três famílias do Design System (`Orbita Design System.dc.html`, seção 02):
 * Space Grotesk no display e em **todo número financeiro**, Archivo na
 * interface, JetBrains Mono em eyebrow, status e código.
 */
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "Orbita - Dashboard de Vendas e Cache Bling ERP",
  description: "Centralize e gerencie seus pedidos, clientes e faturamento do Bling ERP em tempo real com o cache rápido e resiliente do Supabase.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      // O tema vive num atributo do `html`, e nenhum componente lê cor fora dos
      // tokens. Hoje só existe `dark`: os valores do tema claro já estão
      // declarados em `tokens.css`, mas o interruptor é de outra fatia.
      data-theme="dark"
      className={`${spaceGrotesk.variable} ${archivo.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
