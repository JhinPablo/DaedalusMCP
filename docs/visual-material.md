# Escenario, temas y vidrio de Daedalus

El escenario diurno y su variante nocturna comparten encuadre y arquitectura. Los recursos originales se generaron para Daedalus; la imagen nocturna es una edición de iluminación de la diurna. Remotion compone las imágenes con un desplazamiento suave, luz, sombras, reflejos y estrellas. No se exporta un vídeo ni se usa un servicio de render externo. La composición dura 960 fotogramas a 24 fps y repite sin salto.

## Superficies y alcance

| Superficie existente                                                                        | Material                | Lente                                           | Motivo                                                               |
| ------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `.sheet`                                                                                    | Vidrio adaptado al tema | Borde con separación RGB en Chromium compatible | Se superpone directamente al escenario                               |
| `.sidebar` en escritorio                                                                    | Vidrio adaptado al tema | No                                              | Navegación sobre el escenario; evitar trabajo de filtro redundante   |
| `.topbar`                                                                                   | Vidrio adaptado al tema | No                                              | Barra con menús superpuestos; conservar composición estable          |
| Conversación: mensajes del usuario, editor, controles, panel de contexto y páginas de datos | Sólido                  | No                                              | Áreas de lectura y edición; no convertir los fondos planos en vidrio |
| Permisos, errores, modales y navegación móvil                                               | Sólido                  | No                                              | Mantener semántica, contraste y estabilidad de las capas animadas    |
| Lienzo y nodos del flujo                                                                    | Sólido                  | No                                              | Su fondo es plano y contiene datos                                   |

El helper de lente solo se activa tras decodificar sus mapas. Reutiliza mapas de esquinas y bandas por radio/ancho de borde; al redimensionar, coloca y estira esas bandas sin regenerar sus píxeles. Cada superficie utiliza un filtro e identificador propios. El centro es neutro. Se excluyen Firefox, superficies menores de 32 px, transformaciones, `will-change` y curvas que no coincidan con la geometría circular disponible: conservan el vidrio CSS.

El fondo es una composición viva, por lo que se utiliza explícitamente la tinta del tema y la densidad alta de fallback. Los textos pequeños expuestos al fondo usan también la tinta principal; los paneles sólidos conservan su tinta secundaria. No se afirma muestrear fotogramas de Remotion como si fueran una imagen estática. La función de adaptación conserva el cálculo por muestras, descarte de extremos e histéresis para fuentes estáticas legibles.

## Preferencias y accesibilidad

El control Apariencia ofrece claro, oscuro o sistema, intensidades independientes de 0 a 1.5 y pausa del fondo. Se recuperó el manejo de preferencias de la tarea completada en el commit `57615cc`, sacándolo de App a un módulo probado. No se reejecutaron los agentes ni se cambiaron sus resultados históricos.

`prefers-reduced-motion` detiene el reproductor. Ocultar la pestaña también lo pausa. `prefers-reduced-transparency` conserva superficies sólidas y elimina la lente; `forced-colors` oculta el fondo y utiliza colores del sistema. El panel explica las preferencias que impiden ver la animación o la transparencia. La geometría del chat, los radios, fuentes e iconografía se conservan.

Las pruebas verifican progreso real de fotogramas, selección de recursos, temas, persistencia, controles, fallbacks, rutas de notificaciones y ausencia de desbordamiento móvil. Las capturas locales de QA quedan en `.daedalus/qa/` y no forman parte del repositorio público.
