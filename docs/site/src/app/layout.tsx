import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/next'
import './globals.css'

const siteUrl = 'https://odin.unempyd.com'

export const metadata: Metadata = {
  title: 'Odin Docs',
  description:
    'Product documentation for Odin — a surgical derivative of Orca, the worktree IDE for AI coding agents, with residual orchestration and safety contracts closed.',
  metadataBase: new URL(siteUrl),
  applicationName: 'Odin Docs',
  icons: {
    icon: '/docs/favicon.ico',
    shortcut: '/docs/favicon.ico'
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: `${siteUrl}/docs`,
    siteName: 'Odin',
    title: 'Odin Docs',
    description:
      'Product documentation for Odin — a surgical derivative of Orca, the worktree IDE for AI coding agents, with residual orchestration and safety contracts closed.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Odin Docs',
    description:
      'Product documentation for Odin — a surgical derivative of Orca, the worktree IDE for AI coding agents, with residual orchestration and safety contracts closed.'
  },
  robots: {
    index: true,
    follow: true
  },
  alternates: {
    canonical: `${siteUrl}/docs`
  }
}

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <html lang="en" className="bg-background text-foreground" suppressHydrationWarning>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <RootProvider search={{ enabled: false }} theme={{ defaultTheme: 'dark' }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
