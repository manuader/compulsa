CREATE TYPE "public"."origen_precio" AS ENUM('csv', 'manual');--> statement-breakpoint
ALTER TYPE "public"."origen_item" ADD VALUE 'inferido';--> statement-breakpoint
ALTER TYPE "public"."regla_deduccion" ADD VALUE 'cruce';--> statement-breakpoint
ALTER TYPE "public"."regla_deduccion" ADD VALUE 'medicion_grafica';--> statement-breakpoint
ALTER TYPE "public"."rubro" ADD VALUE 'terminaciones';--> statement-breakpoint
ALTER TYPE "public"."rubro" ADD VALUE 'sanitaria';--> statement-breakpoint
ALTER TYPE "public"."rubro" ADD VALUE 'electrica';--> statement-breakpoint
ALTER TYPE "public"."rubro" ADD VALUE 'demolicion';--> statement-breakpoint
ALTER TYPE "public"."tipo_entidad" ADD VALUE 'tramo';--> statement-breakpoint
ALTER TYPE "public"."tipo_entidad" ADD VALUE 'accesorio';--> statement-breakpoint
ALTER TYPE "public"."tipo_entidad" ADD VALUE 'boca';--> statement-breakpoint
CREATE TABLE "datos_obra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"clave" text NOT NULL,
	"valor_json" jsonb NOT NULL,
	"origen" "origen_item" NOT NULL,
	"fuentes_json" jsonb NOT NULL,
	"confianza" real NOT NULL,
	"metodo" text,
	"definido_por" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datos_obra_obra_clave_uq" UNIQUE("obra_id","clave")
);
--> statement-breakpoint
CREATE TABLE "precios_referencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"clave_item" text NOT NULL,
	"descripcion" text NOT NULL,
	"unidad" "unidad" NOT NULL,
	"precio" numeric(14, 2) NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"fecha" text NOT NULL,
	"origen" "origen_precio" NOT NULL,
	CONSTRAINT "precios_referencia_estudio_clave_uq" UNIQUE("estudio_id","clave_item")
);
--> statement-breakpoint
ALTER TABLE "computo_items" ADD COLUMN "precio_json" jsonb;--> statement-breakpoint
ALTER TABLE "entidades" ADD COLUMN "elemento_id" uuid;--> statement-breakpoint
ALTER TABLE "hallazgos" ADD COLUMN "target_dato" jsonb;--> statement-breakpoint
ALTER TABLE "obras" ADD COLUMN "analisis_json" jsonb;--> statement-breakpoint
ALTER TABLE "datos_obra" ADD CONSTRAINT "datos_obra_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datos_obra" ADD CONSTRAINT "datos_obra_definido_por_usuarios_id_fk" FOREIGN KEY ("definido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precios_referencia" ADD CONSTRAINT "precios_referencia_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "datos_obra_obra_idx" ON "datos_obra" USING btree ("obra_id");