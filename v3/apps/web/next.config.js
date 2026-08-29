/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are TypeScript source (not pre-built dist), so Next
  // must transpile them itself.
  transpilePackages: ['@beauclick/design-tokens', '@beauclick/persian-utils', '@beauclick/payment-contract'],
  eslint: {
    // Linting is a separate Nx target (`nx run web:lint`) using the
    // workspace's own config, including the module-boundary rule -- Next's
    // own build-time lint pass would use a different config and duplicate
    // the work.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
