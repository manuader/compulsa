import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Este repo es la raíz: sin esto Next infiere el workspace desde lockfiles de
  // directorios superiores y avisa en cada build.
  outputFileTracingRoot: process.cwd(),

  // Paquetes que corren solo en el server y no deben pasar por el bundler:
  // PGlite carga su WASM desde disco, pdfjs-dist usa su build legacy y exceljs
  // resuelve dependencias en runtime. Bundlearlos los rompe.
  serverExternalPackages: ['@electric-sql/pglite', 'pdfjs-dist', 'exceljs'],
};

export default nextConfig;
