import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Skip ESLint during production builds — lint is run separately via `npm run lint`
  eslint: { ignoreDuringBuilds: true },

  // Use webpack for native module support
  serverExternalPackages: ['keytar'],


  webpack: (config) => {
    // Handle native modules
    config.externals = config.externals || [];
    if (Array.isArray(config.externals)) {
      config.externals.push('keytar');
    }

    // Ensure @/* imports resolve even when tsconfig path detection is unavailable.
    const existingAlias = config.resolve?.alias;
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(existingAlias && !Array.isArray(existingAlias) ? existingAlias : {}),
      '@': path.resolve(__dirname, 'src'),
    };

    return config;
  },

  async redirects() {
    return [
      // Temporarily disable legacy /app entry point while keeping route code in-repo.
      { source: '/app/:path*', destination: '/wallet', permanent: false },
    ];
  },
};

export default nextConfig;
