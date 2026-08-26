CREATE TYPE "public"."actor_tipo" AS ENUM('usuario', 'agente');--> statement-breakpoint
CREATE TYPE "public"."disciplina" AS ENUM('arquitectura', 'estructura', 'instalaciones', 'otra');--> statement-breakpoint
CREATE TYPE "public"."estado_analisis" AS ENUM('pendiente', 'procesando', 'analizada', 'bloqueada_escala', 'error');--> statement-breakpoint
CREATE TYPE "public"."estado_hallazgo" AS ENUM('abierto', 'respondido', 'descartado');--> statement-breakpoint
CREATE TYPE "public"."estado_item" AS ENUM('activo', 'anulado');--> statement-breakpoint
CREATE TYPE "public"."estado_obra" AS ENUM('activa', 'archivada');--> statement-breakpoint
CREATE TYPE "public"."estado_reforma" AS ENUM('existente', 'demoler', 'nueva', 'na');--> statement-breakpoint
CREATE TYPE "public"."estado_rubro" AS ENUM('borrador', 'revision', 'aprobado');--> statement-breakpoint
CREATE TYPE "public"."origen_item" AS ENUM('explicito', 'deducido', 'supuesto');--> statement-breakpoint
CREATE TYPE "public"."rol_usuario" AS ENUM('titular', 'colaborador', 'lectura');--> statement-breakpoint
CREATE TYPE "public"."rubro" AS ENUM('aberturas', 'seco', 'pintura', 'gruesa');--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('plano', 'pliego', 'planilla', 'memoria', 'foto', 'otro');--> statement-breakpoint
CREATE TYPE "public"."tipo_entidad" AS ENUM('ambiente', 'muro', 'tabique', 'abertura', 'artefacto', 'terminacion', 'otro');--> statement-breakpoint
CREATE TYPE "public"."tipo_hallazgo" AS ENUM('faltante', 'inconsistencia', 'existente_confirmar', 'supuesto');--> statement-breakpoint
CREATE TYPE "public"."tipo_lamina" AS ENUM('planta', 'corte', 'vista', 'detalle', 'planilla', 'otra');--> statement-breakpoint
CREATE TYPE "public"."tipo_obra" AS ENUM('nueva', 'reforma', 'ampliacion');--> statement-breakpoint
CREATE TYPE "public"."unidad" AS ENUM('u', 'm', 'ml', 'm2', 'm3', 'l', 'kg');--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid,
	"actor_tipo" "actor_tipo" NOT NULL,
	"actor_nombre" text NOT NULL,
	"accion" text NOT NULL,
	"target_ref" text,
	"diff_json" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computo_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"rubro" "rubro" NOT NULL,
	"entidad_id" uuid,
	"clave_item" text NOT NULL,
	"descripcion" text NOT NULL,
	"unidad" "unidad" NOT NULL,
	"cant_neta" numeric(12, 2) NOT NULL,
	"desperdicio_pct" numeric(5, 2) NOT NULL,
	"cant_compra" numeric(12, 2) NOT NULL,
	"presentacion" text NOT NULL,
	"origen" "origen_item" NOT NULL,
	"fuentes_json" jsonb NOT NULL,
	"confianza" real NOT NULL,
	"estado" "estado_item" DEFAULT 'activo' NOT NULL,
	"editado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computo_rubros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"rubro" "rubro" NOT NULL,
	"estado" "estado_rubro" DEFAULT 'borrador' NOT NULL,
	"aprobado_por" uuid,
	"aprobado_at" timestamp with time zone,
	CONSTRAINT "computo_rubros_obra_rubro_uq" UNIQUE("obra_id","rubro")
);
--> statement-breakpoint
CREATE TABLE "documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"nombre_archivo" text NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"archivo_ref" text NOT NULL,
	"mime" text NOT NULL,
	"hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"subido_por" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entidades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"lamina_id" uuid NOT NULL,
	"tipo" "tipo_entidad" NOT NULL,
	"nombre" text NOT NULL,
	"atributos_json" jsonb NOT NULL,
	"estado_reforma" "estado_reforma" DEFAULT 'na' NOT NULL,
	"fuentes_json" jsonb NOT NULL,
	"confianza" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estudios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hallazgos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obra_id" uuid NOT NULL,
	"clave" text NOT NULL,
	"tipo" "tipo_hallazgo" NOT NULL,
	"rubro" "rubro",
	"descripcion" text NOT NULL,
	"checklist_item" text,
	"laminas_json" jsonb NOT NULL,
	"target_ref" jsonb,
	"bloqueante" boolean NOT NULL,
	"estado" "estado_hallazgo" DEFAULT 'abierto' NOT NULL,
	"respuesta_json" jsonb,
	"resuelto_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hallazgos_obra_clave_uq" UNIQUE("obra_id","clave")
);
--> statement-breakpoint
CREATE TABLE "laminas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"numero_pagina" integer NOT NULL,
	"codigo" text,
	"titulo" text,
	"disciplina" "disciplina",
	"tipo" "tipo_lamina",
	"escala" text,
	"escala_confiable" boolean DEFAULT false NOT NULL,
	"revision" text,
	"estado_analisis" "estado_analisis" DEFAULT 'pendiente' NOT NULL,
	"error_detalle" text,
	"archivo_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"zona" text NOT NULL,
	"tipo" "tipo_obra" NOT NULL,
	"moneda" text DEFAULT 'ARS' NOT NULL,
	"estado" "estado_obra" DEFAULT 'activa' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sesiones" (
	"token" text PRIMARY KEY NOT NULL,
	"usuario_id" uuid NOT NULL,
	"expira_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estudio_id" uuid NOT NULL,
	"email" text NOT NULL,
	"nombre" text NOT NULL,
	"password_hash" text NOT NULL,
	"rol" "rol_usuario" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computo_items" ADD CONSTRAINT "computo_items_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computo_items" ADD CONSTRAINT "computo_items_entidad_id_entidades_id_fk" FOREIGN KEY ("entidad_id") REFERENCES "public"."entidades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computo_items" ADD CONSTRAINT "computo_items_editado_por_usuarios_id_fk" FOREIGN KEY ("editado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computo_rubros" ADD CONSTRAINT "computo_rubros_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computo_rubros" ADD CONSTRAINT "computo_rubros_aprobado_por_usuarios_id_fk" FOREIGN KEY ("aprobado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_subido_por_usuarios_id_fk" FOREIGN KEY ("subido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entidades" ADD CONSTRAINT "entidades_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entidades" ADD CONSTRAINT "entidades_lamina_id_laminas_id_fk" FOREIGN KEY ("lamina_id") REFERENCES "public"."laminas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hallazgos" ADD CONSTRAINT "hallazgos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hallazgos" ADD CONSTRAINT "hallazgos_resuelto_por_usuarios_id_fk" FOREIGN KEY ("resuelto_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laminas" ADD CONSTRAINT "laminas_documento_id_documentos_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laminas" ADD CONSTRAINT "laminas_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obras" ADD CONSTRAINT "obras_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_estudio_id_estudios_id_fk" FOREIGN KEY ("estudio_id") REFERENCES "public"."estudios"("id") ON DELETE no action ON UPDATE no action;