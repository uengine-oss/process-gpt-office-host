// Our product identity in place of IeumOffice's, applied at build time so the fork
// stays untouched. Apache-2.0 §6 grants no rights to the licensor's names or marks,
// so the editors must not present themselves as IeumOffice / GenOffice; the
// attribution itself stays in LICENSE, NOTICE and THIRD-PARTY-NOTICES (see
// ../NOTICE.md).
//
//   IEUM_BRAND_NAME     default "Process GPT Office"
//   IEUM_BRAND_NAME_KO  default "Process GPT 오피스"
export const BRAND_NAME = process.env.IEUM_BRAND_NAME || 'Process GPT Office'
export const BRAND_NAME_KO = process.env.IEUM_BRAND_NAME_KO || 'Process GPT 오피스'

const PRODUCT_TS = /[\\/]packages[\\/]i18n[\\/]src[\\/]product\.ts$/
const AI_MARK_TSX = /[\\/]packages[\\/]ui[\\/]src[\\/]AiMark\.tsx$/

// a plain sparkle for the AI entry points, drawn for this integration (no IeumOffice artwork)
const AI_MARK_SOURCE = `export interface AiMarkProps {
  size?: number
  className?: string
}

export function AiMark({ size = 18, className }: AiMarkProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M10 3.5 11.7 8.3 16.5 10 11.7 11.7 10 16.5 8.3 11.7 3.5 10 8.3 8.3Z" />
      <path d="M17.5 14.5 18.3 16.7 20.5 17.5 18.3 18.3 17.5 20.5 16.7 18.3 14.5 17.5 16.7 16.7Z" />
    </svg>
  )
}
`

/** source replacement for a module the brand touches; null = leave the module as it is */
export function rebrandModule(id, code) {
  if (PRODUCT_TS.test(id)) {
    const out = code
      .replace(/export const PRODUCT_NAME = '[^']*'/, `export const PRODUCT_NAME = ${JSON.stringify(BRAND_NAME)}`)
      .replace(/ko: '[^']*',/, `ko: ${JSON.stringify(BRAND_NAME_KO)},`)
    if (out === code) throw new Error('brand: product.ts no longer matches; check packages/i18n/src/product.ts')
    return out
  }
  if (AI_MARK_TSX.test(id)) return AI_MARK_SOURCE
  return null
}

export const rebrandTitle = (html) => html.replace(/<title>IeumOffice ([^<]*)<\/title>/, (_m, rest) => `<title>${BRAND_NAME} ${rest}</title>`)

/** Vite plugin (build-web.mjs, vite.web.config.mjs) */
export function viteBrand() {
  return {
    name: 'ieum-brand',
    enforce: 'pre',
    transform(code, id) {
      const out = rebrandModule(id.split('?')[0], code)
      return out === null ? null : { code: out, map: null }
    },
    transformIndexHtml: rebrandTitle,
  }
}

/** esbuild plugin (build.mjs: host and preload bundles) */
export function esbuildBrand() {
  return {
    name: 'ieum-brand',
    setup(b) {
      b.onLoad({ filter: /(product\.ts|AiMark\.tsx)$/ }, async (args) => {
        const { readFile } = await import('node:fs/promises')
        const out = rebrandModule(args.path, await readFile(args.path, 'utf8'))
        return out === null ? undefined : { contents: out, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })
    },
  }
}
