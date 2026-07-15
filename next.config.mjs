/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse and mammoth read files at request time; keep them out of the
  // client bundle and let Next.js treat them as normal server dependencies.
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
