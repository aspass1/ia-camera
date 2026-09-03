import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://linhacount-tecidos.mateusdaluz2111.chatgpt.site'),
  title: 'Controle de produção — Contagem de tecidos',
  description: 'Contagem visual de retiradas de tecido com câmera e calibração assistida.',
  openGraph: {
    title: 'Controle de produção',
    description: 'Contagem inteligente de tecidos',
    images: ['/linhacount/logo-marca.jpg'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Controle de produção',
    description: 'Contagem inteligente de tecidos',
    images: ['/linhacount/logo-marca.jpg'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
