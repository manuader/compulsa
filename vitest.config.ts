import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /**
     * Los defaults de vitest (5 s de test, 10 s de hook) están pensados para
     * tests que no levantan una base. Los nuestros sí: cada archivo de
     * integración crea un PGlite en memoria y le corre las migraciones en un
     * `beforeEach`, y eso con la máquina ocupada pasa de 10 s sin ser un fallo.
     *
     * Se pagó caro: una corrida de `npm test` a secas mientras corrían otras
     * ramas dio **583 rojos** que no eran de aserción, todos `Hook timed out`.
     * Un timeout de infraestructura disfrazado de test roto cuesta horas de
     * diagnóstico y, peor, entrena a leer un rojo como ruido.
     */
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
});
