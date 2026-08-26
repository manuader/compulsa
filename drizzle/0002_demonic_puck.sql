ALTER TABLE "notificaciones" ADD COLUMN "clave_dedup" text;--> statement-breakpoint
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_usuario_dedup_uq" UNIQUE("usuario_id","clave_dedup");