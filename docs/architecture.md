# Arquitectura y límites de Daedalus

El navegador, el conector local y los clientes MCP se autentican por separado. Solo una sesión del propietario, validada con el JWT de Cloudflare Access, puede decidir aprobaciones y permisos. El Worker comprueba firma, emisor, audiencia y correo del propietario. Las credenciales MCP y de conector se guardan como hashes SHA-256 y son revocables.

El Durable Object es la unidad de coordinación del espacio personal. Una transición del motor se valida sobre una copia, se persiste síncronamente en SQLite y después se notifica por WebSocket. El MCP y la API usan el mismo servicio. Un fallo de validación no guarda una transición parcial. El conector consulta su cola mediante HTTPS saliente; el navegador recibe invalidaciones por WebSocket y conserva polling de respaldo.

Cada propuesta tiene una versión y un digest de todo el plan, incluyendo el prompt, las dependencias y los criterios. La ejecución requiere dos aprobaciones del propietario para esa versión. Los agentes no tienen una herramienta de aprobación. Cambiar el plan mientras hay trabajo activo o incierto está bloqueado. Las solicitudes adicionales de comandos y archivos de Codex se devuelven al panel.

El conector solo reconoce proyectos de su configuración local. Ejecuta Git mediante argumentos, sin interpolación de shell. Codex trabaja en worktrees separados; las ramas completadas se integran en los siguientes worktrees. Los conflictos paran la tarea y conservan los archivos. La revisión final es un turno separado con sandbox de solo lectura. No se hace push ni se modifica la rama original automáticamente.

El journal local se escribe antes de comenzar y antes de publicar el resultado. Si el proceso se reinicia durante un turno, se informa un resultado incierto; no se vuelve a lanzar el prompt. Los resultados terminados pueden republicarse de forma idempotente. Si el conector deja de dar señales por más de 90 segundos, el servidor conserva la ejecución como incierta. La cancelación es cooperativa: el proceso local debe confirmar la interrupción.

OpenCode utiliza exclusivamente un modelo `deepseek…-free` del proveedor `opencode`, con coste de entrada y salida cero en su catálogo. El respaldo opcional y explícito `planningFallback: luna-high` deriva una petición fallida a Codex App Server con `gpt-6-luna`, esfuerzo `high` y sandbox de solo lectura. Se valida que el catálogo de la cuenta ofrezca ese modelo y esfuerzo; no se sustituye por otro. La cancelación no activa un respaldo y no se reintentan ejecuciones de implementación. El conector informa por separado la disponibilidad de OpenCode, la de planificación y el modelo seleccionado. Los errores y cambios de motor quedan en los eventos. Codex elimina `OPENAI_API_KEY` de su entorno y comprueba que `account/read` reporte autenticación `chatgpt` antes de abrir un turno.

Las skills se fijan por commit. La sincronización no ejecuta instaladores ni código de las fuentes. Sus licencias, referencias y recursos permanecen en el checkout local. La carga de contexto es selectiva; las referencias de texto se acotan para no exceder el presupuesto. Las fuentes pueden archivarse en R2 con `skills:sync -- --upload`.

El catálogo descarta fixtures y archivos de prueba, y registra una única distribución canónica por identificador de skill. El contexto incluye instrucciones principales completas y un índice de referencias locales validadas dentro de la fuente; no inserta automáticamente todas las referencias. Si una instrucción principal supera el presupuesto, se conserva íntegra en disco y se exige leerla por demanda. Los fallos de preparación se distinguen de las ejecuciones iniciadas: el reintento explícito del propietario crea un nuevo run y exige la aprobación vigente; nunca se reutiliza un run terminal ni se repite un resultado incierto.

## Operación

- El equipo local debe estar encendido y conectado para ejecutar. El hosting no ejecuta el código del usuario.
- Las suscripciones y modelos pueden imponer límites. Una pausa no activa facturación de otro proveedor.
- La aplicación es para un propietario. No incluye colaboración multiusuario ni publicación automática.
- En producción no existe bypass de autenticación. El servidor de desarrollo, limitado a loopback y con controles de origen, es exclusivamente local y no debe publicarse mediante un túnel.
- Una revisión final completada significa que se entregó un informe; no equivale a ausencia de hallazgos. Consulta el veredicto y las pruebas.
