CREATE TYPE "public"."canal" AS ENUM('manual', 'whatsapp', 'voz', 'email');--> statement-breakpoint
CREATE TYPE "public"."direccion_mensaje" AS ENUM('saliente', 'entrante');--> statement-breakpoint
CREATE TYPE "public"."estado_compulsa" AS ENUM('borrador', 'lanzada', 'cerrada', 'adjudicada');--> statement-breakpoint
CREATE TYPE "public"."estado_contacto" AS ENUM('pendiente', 'contactado', 'cotizo', 'negociando', 'cerrado', 'sin_respuesta');--> statement-breakpoint
CREATE TYPE "public"."estado_cotizacion" AS ENUM('recibida', 'conciliada', 'descartada');--> statement-breakpoint
CREATE TYPE "public"."estado_deduccion" AS ENUM('propuesta', 'validada', 'rechazada');--> statement-breakpoint
CREATE TYPE "public"."match_conciliacion" AS ENUM('exacto', 'parcial', 'sustituto', 'no_cotizado', 'extra');--> statement-breakpoint
CREATE TYPE "public"."origen_proveedor" AS ENUM('agenda', 'manual', 'historico');--> statement-breakpoint
CREATE TYPE "public"."regla_deduccion" AS ENUM('planilla_plano', 'planta_corte', 'continuidad', 'idem_tipologia', 'cierre_cotas');--> statement-breakpoint
CREATE TYPE "public"."resultado_negociacion" AS ENUM('pendiente', 'aceptada', 'rechazada', 'contraoferta');--> statement-breakpoint
ALTER TYPE "public"."tipo_entidad" ADD VALUE 'cota';--> statement-breakpoint
CREATE TABLE "adjudicaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"compulsa_id" uuid NOT NULL,
	"cotizacion_id" uuid NOT NULL,
	"oc_texto" text NOT NULL,
	"confirmado_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjudicaciones_compulsa_uq" UNIQUE("compulsa_id")
);
--> statement-breakpoint
CREATE TABLE "checklists_estudio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"rubro" "rubro" NOT NULL,
	"item_id" text NOT NULL,
	"descripcion" text NOT NULL,
	"bloqueante" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "checklists_estudio_estudio_rubro_item_uq" UNIQUE("estudio_id","rubro","item_id")
);
--> statement-breakpoint
CREATE TABLE "compulsas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"rubro" "rubro" NOT NULL,
	"estado" "estado_compulsa" DEFAULT 'borrador' NOT NULL,
	"snapshot_hash" text NOT NULL,
	"items_json" jsonb NOT NULL,
	"condiciones_json" jsonb NOT NULL,
	"mandato_json" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"aprobado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conciliacion_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cotizacion_id" uuid NOT NULL,
	"clave_item" text,
	"linea_idx" integer,
	"match" "match_conciliacion" NOT NULL,
	"desvio_json" jsonb,
	"nota" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conciliacion_items_cotizacion_clave_uq" UNIQUE("cotizacion_id","clave_item")
);
--> statement-breakpoint
CREATE TABLE "contactos_compulsa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"compulsa_id" uuid NOT NULL,
	"proveedor_id" uuid NOT NULL,
	"canal" "canal" DEFAULT 'manual' NOT NULL,
	"estado" "estado_contacto" DEFAULT 'pendiente' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contactos_compulsa_compulsa_proveedor_uq" UNIQUE("compulsa_id","proveedor_id")
);
--> statement-breakpoint
CREATE TABLE "cotizaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contacto_id" uuid NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"incluye_iva" boolean NOT NULL,
	"validez_dias" integer,
	"plazo_dias" integer,
	"forma_pago" text,
	"total" numeric(14, 2),
	"lineas_json" jsonb NOT NULL,
	"raw_texto" text,
	"raw_ref" text,
	"score_fidelidad" numeric(4, 2),
	"estado" "estado_cotizacion" DEFAULT 'recibida' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deducciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"entidad_id" uuid NOT NULL,
	"campo" text NOT NULL,
	"regla" "regla_deduccion" NOT NULL,
	"fuentes_json" jsonb NOT NULL,
	"valor_json" jsonb NOT NULL,
	"confianza" real NOT NULL,
	"estado" "estado_deduccion" DEFAULT 'propuesta' NOT NULL,
	"validado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deducciones_obra_entidad_campo_uq" UNIQUE("obra_id","entidad_id","campo")
);
--> statement-breakpoint
CREATE TABLE "invitaciones" (
	"codigo" text PRIMARY KEY NOT NULL,
	"estudio_id" uuid NOT NULL,
	"rol" "rol_usuario" NOT NULL,
	"usada_por" uuid,
	"expira_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mensajes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contacto_id" uuid NOT NULL,
	"direccion" "direccion_mensaje" NOT NULL,
	"canal" "canal" NOT NULL,
	"cuerpo" text NOT NULL,
	"registrado_por" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "negociaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cotizacion_id" uuid NOT NULL,
	"ronda" integer NOT NULL,
	"oferta_json" jsonb NOT NULL,
	"resultado" "resultado_negociacion" DEFAULT 'pendiente' NOT NULL,
	"log_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notificaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"cuerpo" text NOT NULL,
	"link" text,
	"leida" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"clave_item" text NOT NULL,
	"zona" text NOT NULL,
	"mes" text NOT NULL,
	"p25" numeric(14, 2) NOT NULL,
	"p50" numeric(14, 2) NOT NULL,
	"p75" numeric(14, 2) NOT NULL,
	"n" integer NOT NULL,
	"muestras_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "price_index_estudio_clave_zona_mes_uq" UNIQUE("estudio_id","clave_item","zona","mes")
);
--> statement-breakpoint
CREATE TABLE "proveedores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"rubros" "rubro"[] NOT NULL,
	"zona" text NOT NULL,
	"contactos_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opt_in_wa" boolean DEFAULT false NOT NULL,
	"opt_in_registrado_en" timestamp with time zone,
	"opt_out" boolean DEFAULT false NOT NULL,
	"score" real,
	"origen" "origen_proveedor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recomputos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"diff_json" jsonb NOT NULL,
	"motivo" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laminas" ADD COLUMN "texto_extraido" text;--> statement-breakpoint
ALTER TABLE "laminas" ADD COLUMN "procesando_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "obras" ADD COLUMN "resumen_json" jsonb;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "activo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "adjudicaciones" ADD CONSTRAINT "adjudicaciones_compulsa_id_compulsas_id_fk" FOREIGN KEY ("compulsa_id") REFERENCES "public"."compulsas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjudicaciones" ADD CONSTRAINT "adjudicaciones_cotizacion_id_cotizaciones_id_fk" FOREIGN KEY ("cotizacion_id") REFERENCES "public"."cotizaciones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists_estudio" ADD CONSTRAINT "checklists_estudio_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compulsas" ADD CONSTRAINT "compulsas_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compulsas" ADD CONSTRAINT "compulsas_aprobado_por_usuarios_id_fk" FOREIGN KEY ("aprobado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conciliacion_items" ADD CONSTRAINT "conciliacion_items_cotizacion_id_cotizaciones_id_fk" FOREIGN KEY ("cotizacion_id") REFERENCES "public"."cotizaciones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contactos_compulsa" ADD CONSTRAINT "contactos_compulsa_compulsa_id_compulsas_id_fk" FOREIGN KEY ("compulsa_id") REFERENCES "public"."compulsas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contactos_compulsa" ADD CONSTRAINT "contactos_compulsa_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cotizaciones" ADD CONSTRAINT "cotizaciones_contacto_id_contactos_compulsa_id_fk" FOREIGN KEY ("contacto_id") REFERENCES "public"."contactos_compulsa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deducciones" ADD CONSTRAINT "deducciones_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deducciones" ADD CONSTRAINT "deducciones_entidad_id_entidades_id_fk" FOREIGN KEY ("entidad_id") REFERENCES "public"."entidades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deducciones" ADD CONSTRAINT "deducciones_validado_por_usuarios_id_fk" FOREIGN KEY ("validado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitaciones" ADD CONSTRAINT "invitaciones_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitaciones" ADD CONSTRAINT "invitaciones_usada_por_usuarios_id_fk" FOREIGN KEY ("usada_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensajes" ADD CONSTRAINT "mensajes_contacto_id_contactos_compulsa_id_fk" FOREIGN KEY ("contacto_id") REFERENCES "public"."contactos_compulsa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensajes" ADD CONSTRAINT "mensajes_registrado_por_usuarios_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negociaciones" ADD CONSTRAINT "negociaciones_cotizacion_id_cotizaciones_id_fk" FOREIGN KEY ("cotizacion_id") REFERENCES "public"."cotizaciones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_index" ADD CONSTRAINT "price_index_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recomputos" ADD CONSTRAINT "recomputos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conciliacion_items_cotizacion_idx" ON "conciliacion_items" USING btree ("cotizacion_id");--> statement-breakpoint
CREATE INDEX "contactos_compulsa_compulsa_idx" ON "contactos_compulsa" USING btree ("compulsa_id");--> statement-breakpoint
CREATE INDEX "cotizaciones_contacto_idx" ON "cotizaciones" USING btree ("contacto_id");--> statement-breakpoint
CREATE INDEX "deducciones_obra_idx" ON "deducciones" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "mensajes_contacto_idx" ON "mensajes" USING btree ("contacto_id");--> statement-breakpoint
CREATE INDEX "negociaciones_cotizacion_idx" ON "negociaciones" USING btree ("cotizacion_id");--> statement-breakpoint
CREATE INDEX "notificaciones_usuario_idx" ON "notificaciones" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "computo_items_obra_idx" ON "computo_items" USING btree ("obra_id");--> statement-breakpoint
CREATE UNIQUE INDEX "computo_items_obra_clave_activo_uq" ON "computo_items" USING btree ("obra_id","clave_item") WHERE "computo_items"."estado" = 'activo';--> statement-breakpoint
CREATE INDEX "entidades_obra_idx" ON "entidades" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "hallazgos_obra_idx" ON "hallazgos" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "laminas_obra_idx" ON "laminas" USING btree ("obra_id");