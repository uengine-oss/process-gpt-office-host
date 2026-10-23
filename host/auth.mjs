// Who is asking: process-gpt's Supabase access token (HS256, SUPABASE_JWT_SECRET).
// Without the secret the host runs as a local trial and accepts everyone.
import { createHmac, timingSafeEqual } from 'node:crypto'

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || ''

export const authRequired = () => Boolean(JWT_SECRET)

export function verifyToken(token) {
  if (!JWT_SECRET) return { sub: 'dev' }
  const [head, payload, signature] = String(token || '').split('.')
  if (!head || !payload || !signature) throw new Error('missing token')
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${payload}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad token')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('token expired')
  return claims
}

/** the bearer token of an HTTP request, if any */
export const bearerOf = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || ''
