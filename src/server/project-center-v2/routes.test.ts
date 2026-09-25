/**
 * Guarda de fiação das rotas do Project Center v2 (PR 4).
 *
 * O manifest em `http.ts` é a fonte do path de runtime; o TanStack Router monta
 * a rota a partir do **nome do arquivo**. Estes testes garantem que os dois
 * lados não divirjam: arquivo existe, `createFileRoute` aponta para o path do
 * contrato e o método HTTP do handler é o mesmo do manifest.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_CENTER_V2_OPERATIONS_PATH,
  PROJECT_CENTER_V2_ROUTES,
} from './http'

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
)
const ROUTE_TREE = resolve(REPO_ROOT, 'src/routeTree.gen.ts')

/** `{operation_id}` (contrato) ↔ `$operationId` (TanStack Router). */
function appPathFor(contractPath: string): string {
  return `${PROJECT_CENTER_V2_OPERATIONS_PATH}${contractPath.slice(
    '/operations'.length,
  )}`.replace('{operation_id}', '$operationId')
}

describe('fiação das rotas', () => {
  it('cobre exatamente as nove operações do contrato', () => {
    expect(PROJECT_CENTER_V2_ROUTES).toHaveLength(9)
    const ids = PROJECT_CENTER_V2_ROUTES.map((route) => route.operationId)
    expect(new Set(ids).size).toBe(9)
  })

  it('cada arquivo de rota existe e monta o path contratual', () => {
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const file = resolve(REPO_ROOT, route.file)
      expect(existsSync(file), `${route.operationId}: ${route.file}`).toBe(true)

      const source = readFileSync(file, 'utf8')
      const declared = /createFileRoute\(\s*\n?\s*'([^']+)'/u.exec(source)?.[1]
      expect(declared, `${route.operationId}: createFileRoute`).toBe(
        appPathFor(route.contractPath),
      )
      expect(source, `${route.operationId}: OPERATION_ID`).toContain(
        `export const OPERATION_ID = '${route.operationId}'`,
      )
      expect(source, `${route.operationId}: método`).toContain(
        `${route.method}:`,
      )
      expect(source, `${route.operationId}: deps`).toContain(
        'resolveProjectCenterV2Deps',
      )
    }
  })

  it('a árvore gerada declara os nove paths de runtime', () => {
    expect(existsSync(ROUTE_TREE)).toBe(true)
    const tree = readFileSync(ROUTE_TREE, 'utf8')
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      expect(tree, route.operationId).toContain(
        `'${appPathFor(route.contractPath)}'`,
      )
    }
  })

  it('nenhum arquivo de teste ou barrel virou rota', () => {
    const tree = readFileSync(ROUTE_TREE, 'utf8')
    expect(tree).not.toContain('/operations/index')
    expect(tree).not.toContain('.test')
  })
})
