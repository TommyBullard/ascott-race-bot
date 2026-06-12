/** @type {import('next').NextConfig} */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const nextConfig = {
  reactStrictMode: true,
  // Pin the Turbopack workspace root to THIS project. A stray package-lock.json
  // in the parent (home) directory otherwise makes Next infer the wrong root.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
