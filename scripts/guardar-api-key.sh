#!/usr/bin/env bash
#
# Guarda una API key en .env.local, que es de donde Next las lee y el único
# lugar donde este repo acepta un secreto (CLAUDE.md, regla 8).
#
# Tres cosas que este script hace y que un `echo ... >> .env.local` no:
#
#  1. **La key no pasa por el historial del shell.** Se escribe en un prompt que
#     no la muestra, nunca como argumento. Un `FOO=sk-... npm run dev` queda en
#     ~/.zsh_history para siempre y no hay forma de saber quién lo leyó después.
#  2. **El archivo queda 600.** Solo tu usuario lo lee. `umask 077` cubre además
#     el archivo temporal, que es donde un script descuidado filtra el secreto
#     por unos milisegundos con permisos de todos.
#  3. **Es idempotente.** Si la variable ya estaba, se reemplaza esa línea y el
#     resto del archivo queda intacto. Correrlo dos veces no duplica nada.
#
# Uso:
#   ./scripts/guardar-api-key.sh                  # TYPESAFE_API_KEY
#   ./scripts/guardar-api-key.sh ANTHROPIC_API_KEY
#
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
VAR="${1:-TYPESAFE_API_KEY}"

# Un valor por argumento iría derecho al historial: es justo lo que este script
# existe para evitar, así que se rechaza en vez de aceptarse "por comodidad".
if [ "$#" -gt 1 ]; then
  echo "No le pases el valor como argumento: quedaría en el historial del shell." >&2
  echo "Corré '$0 $VAR' sin nada más y pegá la key cuando te la pida." >&2
  exit 2
fi

if ! printf '%s' "$VAR" | grep -Eq '^[A-Z][A-Z0-9_]*$'; then
  echo "'$VAR' no parece un nombre de variable de entorno (A-Z, 0-9, _)." >&2
  exit 2
fi

# Si .env.local dejara de estar ignorado, el próximo commit se lleva el secreto.
if ! git check-ignore -q "$ENV_FILE" 2>/dev/null; then
  echo "CUIDADO: git no está ignorando $ENV_FILE. Arreglá .gitignore antes de seguir." >&2
  exit 1
fi

umask 077

printf 'Pegá el valor de %s (no se muestra al tipear): ' "$VAR" >&2
IFS= read -rs VALOR
printf '\n' >&2

# Espacios y saltos de línea de un copiar/pegar. No se toca nada del medio: una
# key puede tener cualquier cosa adentro y no nos toca a nosotros decidirlo.
VALOR="$(printf '%s' "$VALOR" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$VALOR" ]; then
  echo "No escribiste nada: no toqué $ENV_FILE." >&2
  exit 1
fi

TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

if [ -f "$ENV_FILE" ]; then
  # Todo menos la línea de esta variable (comentada o no); después se agrega la nueva.
  grep -v -E "^[[:space:]]*#?[[:space:]]*${VAR}=" "$ENV_FILE" > "$TMP" || true
  # Una línea en blanco de separación solo si el archivo no terminaba en una.
  if [ -s "$TMP" ] && [ -n "$(tail -c 1 "$TMP")" ]; then printf '\n' >> "$TMP"; fi
fi

printf '%s=%s\n' "$VAR" "$VALOR" >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

# Confirmación sin mostrar el secreto: los últimos 4 caracteres alcanzan para
# saber que se guardó la key que querías y no la del portapapeles anterior.
echo "Guardado $VAR en $ENV_FILE (termina en ...${VALOR: -4}, $(printf '%s' "$VALOR" | wc -c | tr -d ' ') caracteres)."
ls -l "$ENV_FILE" | awk '{print "Permisos:", $1}'
