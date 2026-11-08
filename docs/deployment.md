# Operación estable

Producción sirve `daedalus.<subdominio>.workers.dev`; staging sirve `daedalus-staging.<subdominio>.workers.dev`. Cada Worker tiene su namespace SQLite y su aplicación Access. El repositorio es público; sus credenciales, datos y copias de recuperación permanecen en `.daedalus/` o en secretos de GitHub. No se necesita R2 ni Workers Paid.

## Conector

`npm run connector:install` empaqueta el conector y el lock de skills en una versión inmutable dentro de `.daedalus/runtime/releases/`. `npm run connector:stable` lo inicia con `connector.local.json` y `.daedalus/connection.json`. Mantén el equipo encendido para conversar con los modelos y ejecutar tareas.

`npm run connector:update` prepara otra versión y solicita drenar la anterior. El lanzador espera a que terminen sus tareas y cambia de versión; no cancela ni repite una ejecución. Una interrupción inesperada se reconcilia desde los journals antes de continuar. El checkout editable puede actualizarse sin cambiar el proceso instalado.

## Publicaciones

Para habilitar el publicador configura `publishRepository: "JhinPablo/DaedalusMCP"` y autentica GitHub CLI con acceso a ese repositorio. Los agentes no reciben los secretos de despliegue. Después de la revisión final, el publicador verifica el remoto y los archivos privados, envía la rama y abre un PR sin copiar prompts ni conversaciones a su descripción.

`CI` prueba el código de cada PR sin secretos. El workflow `Staging`, ejecutado desde `main`, solo procesa candidatos registrados de ramas `daedalus/` del mismo repositorio. Descarga su artefacto sin ejecutar código descargado en el job privilegiado. Cada candidato tiene commit, árbol Git, base, ID y digest de artefacto.

En **Publicaciones**, revisa el PR y staging y pulsa **Aprobar publicación**. El conector despacha `Publish`, que vuelve a comprobar la aprobación, CI, artefacto, PR y base de main. Fusiona únicamente si el árbol resultante coincide con el aprobado. Un fallo incierto no se reintenta automáticamente. Los cambios de main o del artefacto requieren otro candidato y aprobación.

La reversión requiere una acción explícita del propietario y una versión previa conocida. Usa `cf` para todos los despliegues. Las migraciones deben ser aditivas. Los assets del artefacto anterior se conservan al publicar y la interfaz anuncia las versiones nuevas sin recargar el chat automáticamente.

## Secretos y variables de GitHub

Secretos: `CLOUDFLARE_API_TOKEN`, `DAEDALUS_CI_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `STAGING_DAEDALUS_CI_TOKEN`, `STAGING_ACCESS_CLIENT_ID`, `STAGING_ACCESS_CLIENT_SECRET` y `OWNER_EMAIL`.

Variables: `CLOUDFLARE_ACCOUNT_ID`, `DAEDALUS_URL`, `STAGING_URL`, `ACCESS_TEAM_DOMAIN`, `PRODUCTION_ACCESS_AUD`, `STAGING_ACCESS_AUD`. La credencial Cloudflare se limita a Workers, observabilidad y lectura de la cuenta. Rota o revoca las credenciales de CI y Access cuando corresponda.

`main` requiere PR y el check `verify`. No se usa `pull_request_target`, y los PRs de forks no reciben secretos ni despliegues privilegiados.

## Migración inicial

Detén el conector cuando no haya tareas activas. Configura hashes y caducidad de credenciales temporales de bootstrap, distintas por entorno, y despliega con Access configurado. `scripts/migrate.ts export` conserva una copia privada y prepara una instantánea sin tareas activas o en cola, con credenciales nuevas. `scripts/migrate.ts import` envía las instantáneas a `DAEDALUS_URL` y `STAGING_URL`, y cambia la configuración local solo si ambas importaciones terminan correctamente.

Los bootstrap tokens y sus hashes se conservan en archivos ignorados durante la instalación. La importación inicial exige una identidad de migración, solo escribe sobre un entorno vacío y no puede reemplazar su estado al repetirse. Retira los hashes del despliegue después de verificar la migración. Nunca habilites un bypass de Access para migrar.

## Límites Free

Se almacenan artefactos de texto de hasta 512 KiB con un máximo de 50 MiB por entorno; los mayores permanecen locales. Las consultas sin cambios no escriben estado. Cada actualización persiste solo las entidades modificadas. El conector consulta cada 5 s cuando trabaja y cada 15 s en reposo; el heartbeat se actualiza como máximo cada 30 s. El navegador usa WebSocket con reconexión y polling de respaldo espaciado. Alcanzar límites no activa servicios de pago ni borra conversaciones.
