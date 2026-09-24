# Compatibilidad de la extensión Anthropic OAuth con Claude Opus 5.5

## Artifact Graph
- Artifact ID: `artifact:anthropic-opus-5-5-oauth-version-spec`
- Role: `spec`
- Standalone: true
- Children: [01-align-claude-code-version.md](../tickets/anthropic-opus-5-5-oauth-version/01-align-claude-code-version.md)

## Tipo y alcance
Análisis de bug y corrección localizada de la identidad de versión enviada por `@wierdbytes/pi-anthropic` al usar OAuth de Claude Pro/Max. No se cambia la lista de modelos de Pi ni se implementa un streamer propio.

## Hechos y evidencia
- Error comunicado por el usuario al usar Opus 5.5: HTTP 400, `claude_code_version_too_old`; el servidor exige Claude Code 2.1.280 o posterior y detecta 2.1.258.
- `packages/anthropic/prompt.ts` antepone `x-anthropic-billing-header: cc_version=2.1.258.d1a; ...` como bloque de sistema. `packages/anthropic/auth.ts` exporta `USER_AGENT = "claude-code/2.1.258"`, aunque no se utiliza dentro de este repositorio.
- El streamer Anthropic de la instalación local de `@earendil-works/pi-ai` usa `claudeCodeVersion = "2.1.280"` para el User-Agent OAuth; la extensión conserva ese streamer. Esta constatación es local y no garantiza todas las versiones instaladas por otros usuarios.
- [Anthropic Models overview](https://platform.claude.com/docs/en/docs/about-claude/models/overview) documenta `claude-opus-5-5`. [Pi custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md) indica que omitir `models` conserva el registro integrado, y Pi puede actualizarlo por catálogo o `models.json`.

## Objetivo y comportamiento esperado
Al enviar una solicitud OAuth a Opus 5.5, la extensión no debe declarar su propia versión obsoleta 2.1.258. El bloque de facturación que agrega debe identificarse con una versión 2.1.280 o superior, coherente con el streamer Pi comprobado, y seguir anteponiéndose una sola vez sin alterar los demás bloques, el flujo OAuth, los otros modelos ni los proveedores ajenos.

## Decisión y límites
- Centralizar la versión de compatibilidad de esta extensión y usarla en las dos declaraciones propias existentes (bloque de facturación y constante exportada). Mantener el formato `cc_version` y demás componentes del bloque, salvo la versión, sin nuevos shims ni listas de modelos.
- Si un bloque de facturación ya está presente, conservar la idempotencia actual: no duplicarlo ni reescribir bloques de procedencia desconocida. Un bloque obsoleto aportado por otra extensión puede seguir fallando y debe diagnosticarse separadamente.
- No cambiar cabeceras del streamer de Pi ni inventar metadatos del modelo. La compatibilidad con otras instalaciones de Pi, los términos de uso de OAuth y la aceptación real del servidor no pueden verificarse sin entorno y credenciales autorizados.
- No publicar, instalar en la configuración del usuario, ni actualizar el binario de Pi como parte de la corrección local.

## Criterios de aceptación
1. Una solicitud sin bloque de facturación obtiene exactamente un bloque inicial con `cc_version=2.1.280.d1a`, no `2.1.258`, manteniendo la semántica restante del sanitizador.
2. Una solicitud que ya contiene un bloque de facturación no recibe un duplicado; bloques no-texto y el contenido no objetivo se preservan.
3. No queda una declaración propia de versión `2.1.258` en el código de la extensión; `USER_AGENT` y el bloque usan la misma fuente de versión.
4. La documentación aclara la causa del error 400 y que ver Opus 5.5 requiere que el catálogo instalado de Pi lo incluya o configurarlo en `models.json`.

## Verificación y riesgos
Prueba unitaria del sanitizador y la coherencia de la versión; comprobación de las cadenas en el paquete; inspección de diff. Opcionalmente una prueba manual con OAuth y Opus 5.5 puede confirmar la aceptación en vivo, pero no se afirmará que se ejecutó ni se usarán credenciales ajenas. El proveedor puede exigir otras capacidades o versiones en el futuro; esta corrección solo elimina la discrepancia observada. La identidad de cliente podría estar sujeta a condiciones del proveedor: no inferir autorización adicional de esta modificación.
