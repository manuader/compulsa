import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` solo necesita schema/out/dialect: genera el SQL sin
// conectarse. La URL queda para los comandos que sí tocan una base real.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/compulsa',
  },
});
