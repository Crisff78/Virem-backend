# Asistente de salud de Virem

Implementación del 22 de septiembre de 2026. Frontend Expo 54/React Native; backend Express 5 y PostgreSQL. No depende de Next.js, Supabase de Korthyx ni rutas absolutas a otro repositorio.

## Ejecución real

Actualización posterior a la validación sintética: el usuario autorizó activar OpenAI real en el portal local. `NODE_ENV=development` y `npm run preview:portal:openai` inicia ese modo en `127.0.0.1:3103`; frontend continúa con `npm run preview:portal` en `8086`. Usa la base temporal y cuentas de prueba, y lee exclusivamente las cuatro variables de OpenAI del `.env` privado, sin cargar la conexión Supabase, JWT real ni servicios de correo. El modo sin consumo continúa con `npm run preview:portal`. No hay cambio automático entre proveedores ni respuestas sintéticas ante errores del modo real.

Se verificó desde el navegador una llamada real a Responses con la pregunta «¿Qué significa hemograma?», resumen y detalles desplegables. Esta comprobación manual tuvo consumo autorizado; los tests automatizados siguen sin APIs de pago. Extracción y transcripción usan los adaptadores reales en este modo, pero no se ejecutaron llamadas reales de esos dos tipos. Las consultas de metadatos indicadas más abajo corresponden a la comprobación inicial anterior a esta activación.

1. Usar Node 20 según `package.json`. En `backend`, ejecutar `npm ci`.
2. Configurar la base y autenticación existentes (`DATABASE_URL` o `DB_*`, `JWT_SECRET`, `CORS_ORIGIN`). Añadir las cuatro variables de IA que se describen abajo.
3. Aplicar `node scripts/migrations.js` contra la base de destino elegida para esta aplicación. El migrador conserva la migración anterior, añade `20260922_patient_assistant` y verifica checksums. El arranque exige esta nueva versión; no modifica el esquema por petición.
4. Iniciar con `npm start`. En `frontend`, instalar con `npm ci --legacy-peer-deps` y ejecutar `npm run start:web` (backend en puerto 3000).
5. Iniciar sesión como paciente y abrir **Asistente de salud** en el portal, o la ruta `/paciente-asistente`.

Por indicación explícita del usuario, se aplicó `20260922_patient_assistant` a la base Supabase configurada en `backend/.env` el 22 de septiembre de 2026 a las 03:48:34 UTC. La migración anterior se conservó y ambos checksums coinciden. Las pruebas funcionales continúan utilizando PostgreSQL/WASM en memoria con usuarios sintéticos.

| Variable privada del backend | Uso |
| --- | --- |
| `OPENAI_API_KEY` | Clave privada configurada en el backend. Se reutilizó la de Korthyx por indicación explícita del usuario. Nunca usar prefijo `EXPO_PUBLIC_`. |
| `VIREM_ASSISTANT_MODEL` | Modelo con Responses, salida JSON estructurada y streaming. |
| `VIREM_DOCUMENT_MODEL` | Modelo con Responses, PDF, visión y salida JSON estructurada. |
| `VIREM_TRANSCRIPTION_MODEL` | Modelo compatible con `/audio/transcriptions`, español y `response_format: json`. |

No hay modelos predeterminados silenciosos. En la configuración privada local se establecieron `VIREM_ASSISTANT_MODEL=gpt-4.1-mini`, `VIREM_DOCUMENT_MODEL=gpt-4.1-mini` y `VIREM_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe`. `OPENAI_API_KEY` está configurada en `backend/.env`, excluido de Git; se copió únicamente esa variable de Korthyx, sin mostrar su valor ni modificar el proyecto de origen. Las consultas `GET /v1/models/{id}` verificaron la autenticación y disponibilidad de ambos modelos únicos. No se ejecutaron Responses ni transcripciones reales, por lo que esta comprobación no acredita una evaluación del contenido ni prueba inferencia. La credencial mantiene el proyecto y cuotas de la cuenta de origen. La falta de configuración produce HTTP 503 explícito; no activa respuestas ficticias. Referencias de compatibilidad: [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) y [GPT-4o mini transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe).

Actualización del 23 de septiembre de 2026: por petición del usuario, la configuración local de respuestas es ahora `VIREM_ASSISTANT_MODEL=gpt-6-astra`. Documentos y dictado conservan sus modelos anteriores. Se confirmó que Astra aparece en el catálogo accesible con la clave local y se completó una llamada real mediante el adaptador `answer`, con JSON validado y nueve actualizaciones de resumen por streaming, usando únicamente un saludo sintético. Esta prueba verifica integración, no calidad clínica. El cambio del `.env` requiere reiniciar los procesos ya iniciados. Verificación posterior del mismo día: `GET /v1/models/gpt-6-astra` respondió 200; tras reiniciar el backend local 3103, una pregunta sintética («¿Qué significa hemograma?») mediante `localAssistantProvider` usó `gpt-6-astra` y completó en unos 8 s con 59 actualizaciones de resumen y respuesta validada por el esquema. No se probó el recorrido HTTP con login. En producción (Render) las variables de OpenAI aún no están configuradas; para usar Astra allí, establecer `VIREM_ASSISTANT_MODEL=gpt-6-astra` junto con las demás. Referencia: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Vista previa aislada y reproducible

En una terminal PowerShell dentro de `backend`:

```powershell
$env:NODE_ENV = 'development'
npm run preview:assistant
```

En otra terminal dentro de `frontend`:

```powershell
npm run preview:assistant
```

Abrir `http://localhost:8085`. El backend escucha únicamente en `127.0.0.1:3101`, no carga `.env`, usa PostgreSQL en memoria y un proveedor sintético. El frontend de vista previa no monta el portal completo ni inicia servicios clínicos. Su barra advierte que son datos de prueba. El modo se condiciona a `__DEV__`; el servidor de producción no importa los adaptadores de prueba. La variable `EXPO_PUBLIC_ASSISTANT_PREVIEW` no habilita el modo en una exportación de producción.

Usar `tests/synthetic-laboratorio.pdf` o generar de nuevo ese archivo desde `tests/helpers/synthetic-pdf.js`. El proveedor de prueba devuelve texto extraído del PDF y explicaciones claramente sintéticas; no evalúa clínicamente el contenido. No adjuntar datos reales en la vista previa.

## Reutilización de Korthyx

Referencia inspeccionada: commit `48982f9cd29c96e18ca6e4f2fae2e2b4e2e554bb`.

- `Composer.tsx` y `AttachmentCardV2.tsx`: se conservó la separación de presentación y estado; se escribió `ViremComposer` en React Native. Se omitieron modos, paciente seleccionado, firma, SOAP, especialidades, incorporación al caso y captura ambiental.
- `useAttachmentAnalysis.ts` y `attachment-analysis.ts`: se adaptaron ciclo de vida, cancelación y detección de formato. Virem además decodifica imágenes y PDF en servidor; no reduce imágenes de informes de forma destructiva.
- `useClinicalChat.ts`, `clinical-chat-core.ts` y `clinical-chat-history.ts`: se adaptaron cancelación, protección ante resultados antiguos e historial limitado. El historial de Virem se reconstruye en servidor; no se acepta historial arbitrario del cliente.
- `useRecorder.ts`: se adaptó inicio/parada explícitos y limpieza de pistas para web. Se evita transcribir al abandonar la pantalla. El adaptador nativo usa `expo-audio`.
- Se inspeccionaron persistencia y rutas de Korthyx, pero no se copiaron: sus roles profesionales, almacenamiento, cuotas, analítica y prompts no corresponden a pacientes.

No se modificó Korthyx ni se copiaron archivos `.env` completos. La decisión posterior del usuario autoriza reutilizar exclusivamente su `OPENAI_API_KEY` en la configuración privada de Virem. La procedencia está documentada sin dependencias de ejecución entre repositorios. Una extracción compartida futura debería limitarse a utilidades puras, con contrato versionado y pruebas; no se creó ni publicó ningún paquete.

## Contrato HTTP

Prefijo `/api/patient-assistant`. Todas las rutas reales requieren Bearer JWT de Virem, usuario activo y rol paciente (1); no hay excepción administrativa para leer estos hilos.

| Método y ruta | Resultado |
| --- | --- |
| `GET /conversation` | Conversación vigente, hasta 100 mensajes recientes y metadatos/extracciones de documentos; `null` si no existe. |
| `POST /conversation` | Recupera o crea la única conversación vigente del usuario. |
| `DELETE /conversations/:conversationId` | Borra conversación y datos dependientes. |
| `POST /conversations/:conversationId/documents` | Multipart con un campo `file`; valida, guarda y devuelve 202 con estado `reading`. |
| `GET /conversations/:conversationId/documents/:id` | Estado `reading`, `ready` o `error`; nunca devuelve los bytes originales. |
| `DELETE /conversations/:conversationId/documents/:id` | Quita el archivo y sus datos. Si el documento llegó a `ready`, borra también los mensajes del hilo para eliminar información derivada y la UI lo confirma antes; una lectura fallida o pendiente se quita sin tocar el hilo. |
| `POST /conversations/:conversationId/messages` | JSON `{ requestId: UUID, question, documentIds: UUID[] }`. Streaming NDJSON con eventos `status`, `content`, `done`, `error`. |
| `GET /conversations/:conversationId/messages/:id` | Consulta el estado persistido de un mensaje. |
| `POST /conversations/:conversationId/messages/:id/stop` | Marca la respuesta detenida y cancela al proveedor. |
| `POST /transcriptions` | Multipart con `audio`; devuelve texto editable. No envía el mensaje de chat. |

`requestId` repetido con idéntico contenido recupera el resultado sin nueva llamada ni cuota (un intento fallido o detenido se repite como evento `error` con su código); con otro contenido devuelve 409. Después de error o detención, **Reintentar respuesta** crea un intento explícito distinto. Un fallo de transporte conserva el identificador original para reconciliar el envío.

La respuesta separa `summary`, `interpretation`, `uncertainty`, `consultation` y `followups`. Los valores del documento proceden exclusivamente de su extracción, no del texto de respuesta. Los números, unidades y rangos se conservan como cadenas. Una cita solo se muestra si página, fragmento y campos coinciden con el texto real extraído del PDF; imágenes y páginas sin texto verificable no muestran citas.

## Límites, cancelación y conservación

- PDF/PNG/JPEG/WebP: 10 MiB, cinco documentos por conversación; PDF hasta 20 páginas y 100 000 caracteres de texto extraíble. Imágenes de una sola página y hasta 25 millones de píxeles. Documentos vacíos, cifrados, dañados o ilegibles generan error.
- Pregunta: 4 000 caracteres. Historial enviado al modelo: hasta seis pares completos y 30 000 caracteres; la interfaz hidrata hasta 100 mensajes recientes. Se conservan más mensajes hasta el vencimiento, aunque no todos se cargan en la interfaz ni se envían al modelo.
- Cuotas diarias por usuario, día UTC: 30 respuestas, 10 lecturas y 30 transcripciones. Las reservas son atómicas y los intentos que llegan al proveedor consumen cuota aunque fallen. Repetir el mismo `requestId` no reserva de nuevo.
- Límite HTTP adicional: 120 solicitudes por minuto y usuario por instancia, compatible con el sondeo de estados. Las cuotas diarias y la exclusión de generación se comparten entre instancias mediante PostgreSQL.
- Solo una respuesta simultánea por conversación/usuario. Archivo y respuesta: plazo de 90 segundos; transcripción: 60 segundos. La grabación termina aproximadamente a los 119 segundos; el servidor rechaza audio que exceda 120 segundos (tolerancia de contenedor: 0,5 s) o 10 MiB. Valida contenedor y duración; no confía en la duración enviada por el cliente.
- La cancelación aborta la llamada local y se comprueba también en PostgreSQL cada 750 ms para otras instancias. Tras un reinicio, operaciones de más de dos minutos se marcan interrumpidas al recuperar el hilo; no se reanudan ni se cobran llamadas automáticas.
- La caducidad se fija a 30 días desde crear la conversación, sin renovarse por actividad. El servidor deniega acceso al vencer; limpieza física al arrancar, cada hora o al recuperar el hilo, con bloqueo asesor. El siguiente arranque limpia vencidos si el servicio estuvo apagado.
- Borrado manual en cascada de mensajes, originales y extracciones. Audio: memoria temporal del servidor y caché local eliminada después de usarlo; nunca se almacena en PostgreSQL. Los borradores viven en memoria del frontend.
- Los logs del asistente omiten cuerpo, query string, nombre de archivo, respuestas y errores crudos del proveedor. No hay herramientas SOAP, búsqueda externa ni acceso al expediente, recetas o citas desde el adaptador IA.
- Las cuatro tablas del asistente tienen RLS habilitado sin políticas de acceso público. La migración revoca los privilegios automáticos de Supabase a todos los roles distintos del propietario, incluido `PUBLIC`; la cuenta PostgreSQL utilizada por Express es ese propietario. Se verificó que `anon`, `authenticated` y `service_role` no pueden acceder directamente mediante los permisos heredados. Las tablas existentes del portal no se modifican por esta restricción.

Responses utiliza `store: false` y archivos inline, sin crear Files ni conversaciones en OpenAI. Esto no equivale a retención cero del proveedor. La eliminación de Virem tampoco elimina copias de seguridad históricas ni modifica políticas del proveedor. Debe documentarse la retención de backups de la instalación y verificarse la configuración de la cuenta antes de usar datos reales. Referencia: https://developers.openai.com/es-419/api/docs/guides/your-data

## Correcciones posteriores a la auditoría (2026-09-22)

- Timeouts: el SDK se clasifica con `instanceof APIConnectionTimeoutError`. El plazo de 90 s de respuesta/lectura y el de 60 s de transcripción abortan con motivo `provider_timeout`: el mensaje queda `error` (no `stopped`) y se registra con `reason: deadline`. Solo la detención del paciente, la desconexión o el borrado quedan como `stopped`/`interrupted`.
- Diagnósticos: `assistant_provider_error` añade un `reason` de lista cerrada (`max_output_tokens`, `content_filter`, `stream_ended`, `response_failed`, `stream_error`, `output_size`, `parse`, `schema`, `empty_summary`, `limit_*`, `deadline`) y `providerStatus` solo con el estado HTTP real del proveedor. Las extracciones se validan con Zod dentro del adaptador, de modo que los fallos de contrato quedan registrados. Una extracción cortada por tokens devuelve `document_incomplete`. Los fallos locales (base de datos, callbacks) se registran como `assistant_internal_error` con la operación, sin contenido, y ya no como error del proveedor. `max_output_tokens` de la respuesta pasa a 8000 para cubrir el máximo del esquema; la extracción mantiene 12 000 por el plazo de 90 s.
- Documentos fallidos: no bloquean el compositor. Quitar un documento que no llegó a `ready` conserva el hilo. El frontend conserva localmente el último archivo subido hasta que la lectura termina bien y ofrece **Reintentar lectura** (nueva subida con su cuota; no se guardan bytes de lecturas fallidas en el servidor).
- Documentos por mensaje: cada documento listo muestra **Incluido en el mensaje** (casilla accesible) y el paciente puede excluirlo; solo los incluidos viajan con el siguiente mensaje. **Reintentar respuesta** reutiliza la pregunta y los `document_ids` originales del mensaje y no modifica el borrador en curso.
- Verificación de valores: además de la cita, cada hallazgo recibe `verified`: `true` si valor, unidad y rango aparecen como tokens completos en la capa de texto del PDF, `false` si alguno no aparece, y `null` si no hay capa de texto (imágenes, PDF escaneados) o valores que comparar. La interfaz advierte en los `false` y el modelo recibe la marca con la instrucción de no presentarlos como confirmados. Limitación: la comparación es literal (un «10» dentro de «x10^3» cuenta como encontrado; «13.5» no coincide con «13,5»).
- Detalles: multer decodifica los nombres de archivo como UTF-8 (`defParamCharset`); con poca altura (menos de 520 px o teclado visible) los adjuntos son el último elemento de la zona desplazable, sin relleno inferior, y la vista se desplaza al final para mostrar entera la tarjeta del archivo pendiente; esa tarjeta se compacta (nombre y estado en una línea, textos breves) y, si hay error de carga, lo muestra en lugar del estado para que el compositor no crezca; sin archivo seleccionado, el error aparece dentro del compositor; los nombres largos se recortan por el medio en JavaScript para conservar la extensión (`ellipsizeMode="middle"` no funciona en web) y el nombre completo queda en la etiqueta accesible; quitar el archivo seleccionado limpia su error; los textos de la vista previa se inyectan desde `AssistantPreview` y no forman parte de `PatientAssistantView`; los bordes de los botones tienen contraste de al menos 3:1.
- Compositor compacto: el campo se ajusta a su contenido (una línea vacío, hasta 160 px o 80 px con poca altura, con desplazamiento interno) y vuelve a una línea al enviar o vaciarse; en web se mide con `scrollHeight` porque react-native-web no encoge el textarea. Con respuestas en pantalla se oculta la etiqueta visible «Tu pregunta» (el nombre accesible se mantiene), se reduce el relleno y los avisos del pie pasan a una sola línea. Cada documento ocupa una fila con nombre, estado breve («Imagen · Listo») y acciones en línea («✓ Incluido», «Quitar»); los nombres largos conservan la extensión. `AssistantButton` expone `aria-checked`, `aria-expanded` y `aria-disabled` explícitos, porque react-native-web no traduce `accessibilityState`, y los textos largos de los botones se ajustan al ancho. Verificado en navegador: compositor de ~285 a 194 px en escritorio y de 263 a 195 px a 390 × 844; campo 44 → 92 → 160 → 44 px; sin desbordes horizontales.
- Reintentos: después de un error informado por el servidor o de una detención del paciente, **Enviar** crea un intento nuevo. Un corte de transporte o el timeout de 100 s del cliente conservan el `requestId` para reconciliar.

### Estado actual (tras las correcciones de auditoría, 2026-09-22)

- Servicios: frontend en 8086 (`npm run preview:portal`) y backend en 3103 con OpenAI (`NODE_ENV=development`, `npm run preview:portal:openai`). El backend se reinició para aplicar todas las correcciones de auditoría (A1–A2, M1–M5 y B1–B5); su base temporal es nueva y hay que volver a iniciar sesión. El backend 3102 ya no está activo y los datos temporales anteriores ya no existen.
- Pruebas: backend **35/35** aisladas (`npm run test:assistant`) y **84/84** completas; frontend **31/31** (`npm test`); TypeScript y exportación web aprobados. La exportación con ambas variables de preview activadas no contiene el destino local, el aviso local, `AssistantPreview` ni el texto de la vista previa.
- Las cifras y estados de las secciones siguientes son históricos y se conservan como registro.

## Validación y continuidad

**Estado posterior a la autorización de OpenAI real (2026-09-22):** las comprobaciones manuales ahora incluyen pregunta libre, extracción y explicación de PDF/PNG sintéticos. Las pruebas automatizadas siguen usando dobles sin llamadas de pago. Se corrigió la eliminación de límites de listas/números del esquema enviado al proveedor; ahora coinciden con la validación local. Los errores de respuesta distinguen formato inválido, interrupción, límite temporal y timeout. El registro técnico omite contenido y cuerpos de error de OpenAI. La causa exacta de los dos fallos genéricos de la sesión anterior no se pudo recuperar; el mismo estudio completó un reintento.

Última ejecución enfocada: **29/29** pruebas backend (`npm run test:assistant`), **28/28** frontend, TypeScript y exportación web aprobados. Un PNG sintético produjo 19 hallazgos y explicación completa; un PDF sintético completó el recorrido HTTP con el backend corregido. El backend nuevo permanece en `3103` (nuevo puerto predeterminado) para preservar la sesión anterior de `3102`. La vista existente de `8086` ya utiliza ese backend mediante su configuración de desarrollo y recarga de Metro: login, asistente y explicación documental verificados en navegador. TypeScript y exportación se repitieron tras conectar la vista; el destino local no se incluye en producción. Estado, comandos y límites: [VALIDACION-PORTAL.md](../../entregables/asistente-salud/VALIDACION-PORTAL.md#corrección-de-explicación-interrumpida-2026-09-22). Los resultados históricos siguientes corresponden a las etapas anteriores.

Validación del frontend completo del portal: `NODE_ENV=development` y `npm run preview:portal` inicia la API aislada en `127.0.0.1:3103`. El comando homónimo del frontend abre `8086`. Reutiliza los handlers reales de login, JWT, usuario activo y rol; sustituye solo la base por PGlite, el proveedor por uno sintético y las lecturas auxiliares por fixtures vacíos. No carga `.env`, recordatorios, correos ni configuración externa. Las cuentas locales, evidencia visual y límites están en [VALIDACION-PORTAL.md](../../entregables/asistente-salud/VALIDACION-PORTAL.md). Esta prueba no valida la lógica de negocio de los demás módulos ni la calidad clínica del proveedor.

- Última ejecución completa: `node --test tests/*.test.js`, **72 pruebas aprobadas**, incluidas las 18 del asistente, siete del migrador y cinco resultados de la nueva integración de login/Bearer (cuatro escenarios y su contenedor). `npm run test:assistant` incluye ambos archivos del asistente.
- Las 18 pruebas del asistente incluyen PostgreSQL real en memoria, multipart, cuotas, caducidad durante generación, transcripción con audio WAV sintético y comprobación de duración. El almacenamiento también rechaza borrar documentos inexistentes o ajenos sin eliminar mensajes. El nuevo caso reproduce los privilegios predeterminados de Supabase y comprueba que se revocan incluso para un rol con `BYPASSRLS`, mientras el propietario conserva acceso.
- Frontend: `npm test` aprueba 27 pruebas, incluidas 15 del asistente; `npm run test:assistant` permite ejecutarlas de forma aislada. Se ejecutan también en CI. Cubren micrófono web/nativo con adaptadores simulados, permiso tardío tras salir, inicio duplicado, cancelación durante preparación y transcripción, eliminación de audio temporal, sesión vencida en multipart/streaming, borrador e idempotencia, selección tardía, respuestas antiguas y borrado pendiente al cambiar de paciente.
- Frontend: `npx tsc --noEmit --pretty false` sin errores y `npm run build` exportó web correctamente.
- Navegador: pregunta sin archivo (sin resultados inventados), sugerencia de seguimiento, Enter para enviar y Shift+Enter para nueva línea, PDF sintético seleccionado/cargando/listo, explicación general, detalles desplegables, detención con borrador conservado y reintento. También se verificó quitar documento y mensajes, rechazar un PDF inválido conservando el borrador y corregirlo con un archivo válido. Revisado a 390 px y escritorio, temas claro/oscuro; sin errores de consola en la revisión anterior al error de formato provocado.
- Revisión adicional: viewport 390 × 440 px para simular poco espacio al abrir el teclado. Los controles permanecen visibles; adjuntos, errores y notas pasan a la zona desplazable. Verificados Tab hasta Enviar y activación con Enter. Esta simulación no sustituye el teclado de un dispositivo físico.
- Las pruebas de prompts comprueban separación de instrucciones/datos, ausencia de herramientas y `store: false`; **no sustituyen una evaluación clínica de un modelo real**. No se hicieron llamadas de pago.
- No se ejecutaron los scripts de smoke/performance que dependen de un backend/base externos. La operación autorizada en Supabase se limitó a la migración y metadatos del esquema; no se consultaron registros de pacientes. No se desplegó y no se publicó ningún paquete.

Activación solicitada completada: clave compartida configurada localmente, modelos visibles mediante la API y migración aplicada a la base Supabase elegida. `assertSchemaReady` pasó; se verificaron cuatro tablas con RLS, cero concesiones a otros roles y almacenamiento `bytea` para documentos. No se modificó la configuración de un servicio alojado ni se reinició el backend remoto. La vista previa de `localhost:8085` continúa usando su proveedor sintético. Se mantiene la condición de no consumir APIs de generación o transcripción en las pruebas.

Validación móvil adicional: `expo export --platform all --output-dir scratch/assistant-native-export --clear`, con `.env` deshabilitado, generó los bundles Hermes de iOS y Android además de web. `expo config --type introspect` confirmó el mensaje de permiso de micrófono iOS, `RECORD_AUDIO` en Android y ausencia de audio en segundo plano. Las pruebas en dispositivos iOS/Android se omitieron por indicación posterior explícita del usuario. No se consideran aprobadas ni forman parte del trabajo pendiente de esta entrega. Véase [validación móvil](../../frontend/ASISTENTE-MOVIL.md).

Incidencias locales: dependencias originales de frontend tenían archivos de OneDrive no disponibles. Se conservaron en `../scratch/node_modules-virem-backup-20260922` (desde la raíz común de proyectos, `scratch/`) y se reinstalaron. `npm ci --legacy-peer-deps` reproduce la instalación porque ya existía un conflicto entre Expo 54 y el plugin WebRTC 14 (espera Expo 55). No se cambió esa integración. Expo también señala versiones previas desalineadas de linking/router/font/types; se documentan para una actualización separada.

`npm audit` informó 17 avisos en backend y 33 en frontend; los paquetes nuevos de backend del asistente no aparecen como vulnerables en ese reporte. No se ejecutó un `audit fix --force` que alterase dependencias ajenas a esta entrega.

Documentación consultada: https://developers.openai.com/api/docs/guides/structured-outputs ; https://developers.openai.com/api/docs/guides/file-inputs ; https://developers.openai.com/api/docs/guides/speech-to-text ; https://docs.expo.dev/versions/v54.0.0/sdk/audio/
