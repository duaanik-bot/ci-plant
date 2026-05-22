/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  experimental: {
    viewTransition: true,
    serverComponentsExternalPackages: ['@prisma/client', 'bcryptjs'],
    optimizePackageImports: [
      'lucide-react',
      'date-fns',
      'recharts',
      'framer-motion',
      '@radix-ui/react-dialog',
      'sonner',
    ],
  },
}

module.exports = nextConfig
