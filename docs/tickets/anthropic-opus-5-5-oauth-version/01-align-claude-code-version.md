---
ticket_schema: 1
ticket_id: "01"
execution_mode: AFK
blocked_by: []
---

# Alinear versión Claude Code del bloque OAuth para Opus 5.5

## Artifact Graph
- Artifact ID: `artifact:anthropic-opus-5-5-oauth-version-01`
- Role: `ticket`
- Parent: [anthropic-opus-5-5-oauth-version.md](../../specs/anthropic-opus-5-5-oauth-version.md)

## Parent Spec
[anthropic-opus-5-5-oauth-version.md](../../specs/anthropic-opus-5-5-oauth-version.md)

## What to Build
Corregir la versión obsoleta que declara el bloque de facturación OAuth de `packages/anthropic` de acuerdo con las decisiones y los criterios de la especificación. Mantener el registro integrado de Pi y su streamer.

## Acceptance Criteria
- [ ] El bloque insertado declara `cc_version=2.1.280.d1a` una sola vez y no altera los bloques no objetivo.
- [ ] La constante exportada de identidad y el bloque comparten la versión; no hay declaraciones propias `2.1.258` en el código.
- [ ] Pruebas dirigidas cubren inserción, idempotencia y preservación; la documentación explica el error y el descubrimiento del modelo.

## Frontier
Listo: sin dependencias ni decisión humana para implementar y probar localmente. La prueba en vivo requiere credenciales OAuth del usuario y queda como puerta de verificación, no de implementación.

## Step-by-Step Implementation Plan
1. Añadir cobertura del sanitizador y fijar el fallo con la versión antigua; comprobar el resultado de la prueba.
2. Compartir la versión 2.1.280 entre `auth.ts` y `prompt.ts`; preservar el formato y el resto del comportamiento.
3. Documentar la resolución del error y cómo disponer del modelo; ejecutar pruebas focalizadas y revisar el diff.

## Testing Plan
Ejecutar pruebas unitarias focalizadas y comprobación de cadenas. Si falta Bun o Vitest, emplear una alternativa local explícita y declarar la limitación. No ejecutar una llamada real a Anthropic sin credenciales y consentimiento adecuados; no atribuir aceptación en vivo a las pruebas locales.

## Out of Scope
- Publicación npm, actualización/instalación de Pi, push, PR y merge.
- Listas estáticas de modelos y reemplazo del streamer OAuth de Pi.
