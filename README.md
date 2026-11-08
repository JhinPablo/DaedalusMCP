# Daedalus

Un taller web para pasar de una idea a un prompt aprobado y a código verificable.

**OpenCode + DeepSeek gratuito planean. Tú decides. Codex construye y revisa con tu sesión de ChatGPT.** El panel, el MCP y el estado se alojan en Cloudflare; un conector saliente ejecuta los motores en tu equipo.

## Iniciar en Windows

Necesitas Node.js 24, Git y Codex con inicio de sesión de ChatGPT. La CLI `cf` instalada recomienda Node 24.22 o superior. Las comprobaciones locales también se realizaron con Node 24.19.

```powershell
npm ci
npm run skills:sync
codex login
```

En tres terminales del directorio del proyecto:

```powershell
npm run opencode:serve
```

```powershell
npm run dev
```

Copia `connector.example.json` a `connector.local.json` y configura las carpetas autorizadas. Para desarrollo usa `http://127.0.0.1:8787`. Después:

```powershell
npm run connector
```

Abre [Daedalus local](http://127.0.0.1:8787). El conector local lee su credencial de desarrollo desde `.daedalus/dev-connector-token`. Para producción crea una credencial desde **Conexiones** y guárdala en `DAEDALUS_CONNECTOR_TOKEN`; no la añadas al JSON ni al código.

`opencode:serve` usa una instalación de OpenCode incluida en el proyecto y datos aislados en `.daedalus/opencode/`, para conservar intacta tu instalación habitual. Puedes apuntar `opencodeUrl` a un servidor propio. El catálogo debe ofrecer `opencode/deepseek-v4.1-flash-free` con coste de entrada y salida cero. Daedalus observa los errores del proveedor y conserva el plazo de espera de los límites gratuitos en `.daedalus/opencode-availability.json`.

Para autorizar el respaldo automático, configura `"planningFallback": "luna-high"` en `connector.local.json`. Si DeepSeek falla, alcanza su cuota o no responde, la misma petición pasa una sola vez a `gpt-6-luna` con esfuerzo `high`, usando Codex App Server con tu sesión de ChatGPT. El panel registra el motivo y el modelo activo. Luna conversa y prepara propuestas en modo de solo lectura; las dos aprobaciones de ejecución siguen siendo obligatorias. Una cancelación no activa el respaldo. Si Luna también falla, el flujo se detiene. El valor predeterminado `none` pausa el flujo sin cambiar de motor. No se usan claves de API ni proveedores de pago de OpenCode.

Los proyectos de ejecución deben ser repositorios Git con un commit inicial y un árbol limpio. Daedalus no descarta ni incluye automáticamente cambios sin commit. La planeación puede funcionar antes de preparar Git.

## Trabajar desde el panel

1. Abre **Chat**, selecciona un proyecto registrado y escribe tu petición. El primer mensaje crea la conversación; **Nuevo chat** inicia otra.
2. Conversa con el planificador en la vista principal. El chat admite Markdown, tablas y código. Abre **Propuesta**, **Flujo** o **Agentes** cuando necesites contexto; cierra el panel o pulsa Escape para volver al chat completo. En móvil se muestra una región a la vez.
3. Aprueba el enfoque. Revisa el prompt exacto, el alcance y las tareas del plan.
4. Aprueba el prompt para iniciar la ejecución. Editarlo crea una versión nueva y exige aprobarla de nuevo.
5. Sigue los agentes y responde permisos desde el panel **Agentes** junto al chat o desde **Ejecución**. Hasta tres ejecutores trabajan a la vez en worktrees separados.
6. Consulta resultados, archivos y pruebas. Una sesión independiente de Codex revisa el resultado integrado en modo de solo lectura.

Las ramas se conservan como `daedalus/<run-id>`. La rama de la revisión contiene la integración del trabajo completado. La rama original del proyecto permanece intacta: revisa e integra esa rama con tu flujo Git habitual. No hay push ni despliegue automático del código generado.

Si una ejecución queda **incierta**, inspecciona su sesión y worktree y registra evidencia en el panel. Puedes confirmar el resultado o descartar la ejecución y volver a planear; no se repite automáticamente. **Detener ejecución** solicita una interrupción cooperativa y espera la confirmación del proceso local.

Si una tarea falla durante la carga de skills, antes de iniciar Codex o preparar un worktree, puedes usar **Reintentar preparación**. Solo el propietario puede hacerlo y el plan debe conservar ambas aprobaciones para la misma versión y digest. Se crea un nuevo intento y el fallido se conserva. Una tarea iniciada o incierta requiere revisión y no ofrece este reintento.

## Validar

```powershell
npm run doctor
npm test
npm run build
npm run deploy:preview
```

`npm test` incluye motor de aprobación, dependencias, concurrencia, cancelación, credenciales, protocolo MCP y Worker/SQLite con Miniflare. El runtime necesita acceso a loopback.

```powershell
npm run test:engines
npm run test:live
```

Estas dos pruebas son opcionales y utilizan los motores reales: consumen la cuota de tu suscripción y del modelo gratuito. `test:live` crea un repositorio aislado bajo `.daedalus/`, planea un archivo de prueba con DeepSeek, simula los dos hitos de autorización del escenario de pruebas y ejecuta una tarea y una revisión con Codex. No cambia los proyectos del usuario ni concede permisos adicionales automáticamente.

Para ver el build final local: `npm run preview`, en [localhost:8788](http://127.0.0.1:8788).

## Publicar en Cloudflare

Se usa exclusivamente `cf`. `cloudflare.config.ts` declara Worker, assets, Durable Object SQLite y R2. `npm run build` genera el Build Output utilizado por `cf deploy --prebuilt`.

1. Inicia sesión: `npm run cf -- auth login`.
2. Configura una aplicación **Cloudflare Access** en el dominio de Daedalus, con una política Allow limitada a tu correo y una política **Service Auth** para los conectores y clientes MCP. Usa credenciales de servicio distintas y revocables para cada cliente. No publiques el servidor local mediante un túnel.
3. Define `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` y `OWNER_EMAIL` en el entorno de compilación. La aplicación verifica el JWT de Access y falla cerrada si falta esta configuración.
4. Ejecuta `npm run build`, después `npm run deploy:preview` y revisa los recursos. Publica con `npm run cf -- deploy --prebuilt`. `cf` puede provisionar el bucket R2 y el Durable Object; el uso se factura según tu cuenta de Cloudflare.
5. Cambia `serverUrl` en el conector a la URL HTTPS publicada. Proporciona localmente `CF_ACCESS_CLIENT_ID` y `CF_ACCESS_CLIENT_SECRET`, además de `DAEDALUS_CONNECTOR_TOKEN`, para pasar la política Service Auth.

El primer acceso del propietario permite crear las credenciales de Daedalus desde el panel. Las credenciales de motores permanecen en el equipo local.

## Conectar un cliente MCP

Endpoint: `https://tu-dominio/mcp`, transporte Streamable HTTP. Configura los encabezados `Authorization: Bearer <credencial-MCP>`, `CF-Access-Client-Id` y `CF-Access-Client-Secret`.

Herramientas: `get_context`, `propose_plan`, `get_run` y `record_observation`. No hay herramientas MCP para aprobar planes, conceder permisos, ejecutar comandos arbitrarios ni suplantar un resultado de Codex.

## Skills y procedencia

`skills-lock.json` fija las cinco fuentes solicitadas por commit: Superpowers, Taste Skill, Remotion, Benji Taylor y Impeccable. `skills:sync` descarga el contenido original sin ejecutar instaladores y conserva licencias y recursos. El cargador verifica el commit y los cambios de los archivos antes de inyectar contexto. Los modelos solo reciben las skills seleccionadas y sus referencias enlazadas.

Para archivar recursos en R2, define `DAEDALUS_SERVER_URL`, `DAEDALUS_CONNECTOR_TOKEN` y las credenciales Service Auth y ejecuta `npm run skills:sync -- --upload`. Cambiar una revisión es una actualización explícita del lock.

Consulta [arquitectura y recuperación](docs/architecture.md). Datos de ejecución, credenciales, worktrees y reportes locales están en `.daedalus/`, excluido de Git.
