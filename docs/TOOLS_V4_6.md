## Novedades y migracion a 4.6.0

El catalogo completo contiene **86 herramientas** (76 anteriores y 10 nuevas). El numero visible depende del perfil global y de las restricciones del cliente. Los nombres tecnicos permanecen estables; el menu agrega nombres humanos, categorias, permisos, riesgo y motivo de bloqueo. Los colores son opcionales: `NO_COLOR` y las salidas no TTY no llevan secuencias ANSI.

| Herramienta nueva | Funcion y limites |
|---|---|
| `code_search_symbols` | Definiciones por heuristicas, busqueda literal, paginacion; no sustituye un servidor de lenguaje. Hasta 2000 entradas, 10 MiB analizados y 1000 coincidencias; informa omisiones/truncamiento. |
| `project_dependency_map` | Dependencias directas de package.json, requirements.txt y go.mod sin ejecutar codigo. Detecta TOML, pero no resuelve su contenido ni dependencias transitivas. |
| `patch_preview` | Reemplazos literales, hashes y previsualizacion acotada. No modifica el archivo. |
| `patch_apply` | Exige `expectedHash`, guarda copia privada del cliente, conserva permisos normales y detecta cambios antes de renombrar. |
| `file_restore_safe` | Exige `backupId` del mismo cliente y archivo. Rechaza modificaciones posteriores, archivos borrados y `force=true`. |
| `project_test_runner` | Pruebas, lint y tipos mediante argumentos estructurados, timeout y gestion de trabajos. ESLint/TypeScript deben estar instalados localmente; no descarga paquetes con npx. |
| `service_diagnostics` | Solo destinos locales seleccionados y autorizados por el operador; no realiza escaneos por defecto. |
| `security_block_history` | Bloqueos de politica del propio cliente, acotados y en memoria del proceso consultado. No es un registro persistente centralizado. |
| `job_list_mine` | Lista y pagina exclusivamente trabajos propios, con filtro de estado. |
| `job_tail_output` | Salida incremental con cursor en bytes, limite de lineas y copia base64 para datos binarios. |

### Menu y permisos por cliente

```bash
./mcpctl.sh permissions --catalog
./mcpctl.sh permissions --catalog --client CLIENT_ID --json
./mcpctl.sh permissions --interactive --client CLIENT_ID
./mcpctl.sh permissions --client CLIENT_ID --deny-tool patch_apply
./mcpctl.sh permissions --client CLIENT_ID --require-approval project_test_runner
./mcpctl.sh permissions --client CLIENT_ID --allow-tool code_search_symbols
./mcpctl.sh permissions --client CLIENT_ID --profile observacion
```

Las modificaciones por cliente se guardan atomicamente en el almacen privado de politicas y se consultan al listar y ejecutar. Un cliente no puede ampliar el perfil global. `--allow-tool` elimina el bloqueo/aprobacion particular, pero no elimina los controles globales. Para dejar todas las herramientas sujetas a consentimiento humano use `MCP_TOOL_APPROVALS=all`; el menu muestra la politica de aprobacion efectiva, no solo la clasificacion de riesgo. Las solicitudes pendientes incluyen rutas afectadas, consecuencias, argumentos y hash, y siguen ligadas a cliente, herramienta, vencimiento y version de politica. No publique esos archivos privados.

### Ejemplo de edicion condicionada

```json
{"name":"patch_preview","arguments":{"path":"src/app.js","patches":[{"search":"return 1","replace":"return 2"}]}}
```

Utilice el `originalHash` devuelto como `expectedHash` de `patch_apply`, con los mismos parches. Conserve su `backupId` para `file_restore_safe`. La previsualizacion truncada no constituye un diff completo aplicable. Limite por archivo/resultado: 512 KiB; hasta 100 reemplazos. Los parches sin `replaceAll` requieren una coincidencia unica.

Las escrituras usan archivo temporal, bloqueo cooperativo entre instancias MCP y una segunda comprobacion de hash/inodo. No constituyen una transaccion atomica con editores externos que ignoren el bloqueo; evite editar simultaneamente el mismo archivo. Las copias quedan en `MCP_BACKUPS_DIR` o `.runtime/backups`, por cliente; la retencion/limpieza es responsabilidad del operador. Tras un cierre abrupto, un bloqueo residual se debe investigar localmente, no se elimina automaticamente.

### Trabajos y comunicacion

`job_start` acepta `idempotencyKey`: repetir la misma clave/contenido recupera el mismo trabajo, incluso terminado; cambiar el contenido produce conflicto. Sin clave, cada solicitud ejecuta un trabajo nuevo. La ventana es de 10 minutos tras finalizar, en memoria: no sobrevive al reinicio. Limites globales: 32 trabajos simultaneos y 256 registros retenidos. No se promete ejecucion exactamente una vez entre reinicios.

`job_status` muestra actividad, duracion, bytes y truncamiento, no un porcentaje inventado. `job_tail_output.nextOffset` permite continuar desde el ultimo byte recibido; `outputBase64` conserva bytes no textuales. `job_cancel` detiene inmediatamente el grupo POSIX creado por el servidor, sin enumerar PIDs ajenos. Procesos que deliberadamente se separen de ese grupo y Windows requieren controles del SO adicionales; no se promete contencion universal de descendientes.

`project_test_runner` devuelve `jobId`, resultado, timeout y salida combinada acotada a 64 KiB. Las pruebas/scripts ejecutan codigo del proyecto: no son herramientas de solo lectura. El perfil restringido usa el sandbox existente; las dependencias deben estar instaladas antes porque no se habilita red automaticamente. Ejemplo: `{"runner":"npm_test","cwd":".","idempotencyKey":"verificar-cambio-1"}`.

Las llamadas MCP exitosas incluyen `_meta.traceId`, duracion y modo de ejecutor. El log `FLUJO` muestra cliente -> servidor -> aprobacion -> ejecutor -> resultado; no incorpora el contenido de los archivos. El diagnostico distingue configurado, disponible y aplicado: este ultimo es desconocido cuando no hay evidencia de un trabajo concreto. No confunda detectar Bubblewrap/systemd con probar aislamiento efectivo.

### Diagnostico opt-in

```bash
MCP_DIAGNOSTIC_PORTS=3000,8080
MCP_DIAGNOSTIC_SERVICES=ssh.service
```

Solo se comprueban destinos de esas listas cuando se solicitan explicitamente. El perfil restringido no inspecciona puertos ni servicios del host. No se configura Cloudflare ni se modifica ningun servicio automaticamente.

### Actualizacion y pruebas

Vuelva a escanear las herramientas en el cliente MCP tras actualizar. Revise permisos y nuevas capacidades antes de usarlas. No es necesario migrar credenciales. Las copias experimentales de Gemini anteriores a esta version no se importan como restauraciones confiables. Las variables de CPU conservan unidades estrictas: porcentaje solo systemd, segundos solo prlimit; configuraciones invalidas o incompatibles se rechazan.

```bash
npm run test:project
npm test
npm run selftest
```

Ejecute las pruebas en una copia temporal sin credenciales reales. La suite de proyecto cubre hashes, conflictos, copias por cliente/ruta, permisos, symlinks, runners, idempotencia, paginacion UTF-8, limites del catalogo y CLI por cliente. Las pruebas automatizadas no certifican un despliegue real de Cloudflare, MFA de un proveedor externo ni los controladores de recursos de cada host.

## Organizacion

Los modulos de las herramientas nuevas se encuentran en `lib/tools/` y sus pruebas en `tests/tools/`. Los puntos de entrada publicos conservan sus rutas para no romper configuraciones existentes. No incluya `.env`, almacenes privados, copias, logs ni informes locales en commits.
