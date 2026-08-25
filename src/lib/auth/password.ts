/**
 * Hash de contraseñas con scrypt de `node:crypto` (sin dependencias externas).
 *
 * Formato guardado en `usuarios.password_hash`:
 *   `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * Los parámetros viajan en el hash: subirlos más adelante no invalida los
 * hashes viejos (se revalidan con los suyos y se re-hashean al próximo login).
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16_384;
const R = 8;
const P = 1;
const LARGO_HASH = 64;
const LARGO_SALT = 16;

export async function hashearPassword(password: string): Promise<string> {
  const salt = randomBytes(LARGO_SALT);
  const derivado = await scrypt(password, salt, LARGO_HASH, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('hex'), derivado.toString('hex')].join('$');
}

/** Comparación en tiempo constante. Devuelve `false` ante cualquier hash ilegible. */
export async function verificarPassword(password: string, hash: string): Promise<boolean> {
  try {
    const [etiqueta, n, r, p, saltHex, hashHex] = hash.split('$');
    if (etiqueta !== 'scrypt') return false;

    const salt = Buffer.from(saltHex, 'hex');
    const esperado = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || esperado.length === 0) return false;

    const derivado = await scrypt(password, salt, esperado.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(derivado, esperado);
  } catch {
    return false;
  }
}
