# Guía y Plantillas Opt-in: Límites de Recursos (CPU, Memoria y Procesos)

## 1. Distinción de Capas de Seguridad
El servidor MCP distingue explícitamente tres capas independientes de protección:
1. **Aislamiento de Sistema de Archivos**: Bubblewrap con montajes de solo lectura (`--ro-bind`), carpetas efímeras (`--tmpfs`), enmascaramiento de archivos sensibles y rutas restringidas por proyecto.
2. **Aislamiento de Red**: Bubblewrap con espacio de nombres de red desasociado (`--unshare-net`) que impide cualquier conexión saliente o entrante no autorizada.
3. **Límites Reales de Recursos (CPU, Memoria y Procesos)**: Gobernanza mediante **cgroups v2** (a través de `systemd-run --user --scope`) o límites POSIX vía `prlimit`.

*Nota de seguridad*: El servidor NO declara "cierre completo" ni "aislamiento total" por tener únicamente timeouts de proceso o límites de buffer de salida. Los límites de recursos deben ser aplicados por el kernel.

---

## 2. Motores Disponibles

El servidor implementa un motor dual de aplicación de límites:

### Motor A: cgroups v2 (`systemd-run --user --scope`)
- **Mecanismo**: Crea un scope efímero bajo el slice del usuario en cgroups v2.
- **Propiedades aplicadas**:
  - `MemoryMax`: Límite estricto de memoria RAM (p. ej. `512M`, `1G`). Si el proceso lo supera, el kernel invoca el OOM killer sobre el scope.
  - `CPUQuota`: Cuota máxima de tiempo de CPU (p. ej. `50%`, `100%`).
  - `TasksMax`: Cantidad máxima de procesos y hilos concurrentes (p. ej. `50`, `100`).
- **Composición con Bubblewrap**: El comando `bwrap` se ejecuta dentro del scope de systemd:
  ```bash
  systemd-run --user --scope -q -p MemoryMax=512M -p CPUQuota=50% -p TasksMax=100 -- bwrap ...
  ```

### Motor B: POSIX Resource Limits (`prlimit`)
- **Mecanismo**: Aplica límites de recursos al proceso y a sus descendientes antes de ejecutar el sandbox.
- **Parámetros aplicados**:
  - `--as=<bytes>`: Espacio de direcciones virtuales máximo.
  - `--nproc=<num>`: Limite de procesos/hilos del UID real, no un cupo exclusivo del trabajo. No restringe a root ni a procesos con las capacidades que lo eximen.
  - `--cpu=<segundos>`: Tiempo acumulado de CPU por proceso; no es una cuota porcentual ni un presupuesto agregado de todo el trabajo.
- Los limites se heredan, pero `--as` limita espacio virtual por proceso, no RAM agregada. Este motor no es equivalente a cgroups; use `systemd` explicitamente cuando necesite limites de todo el scope.
- **Composición con Bubblewrap**:
  ```bash
  prlimit --as=1073741824 --nproc=100 -- bwrap ...
  ```

---

## 3. Variables de Entorno de Configuración

| Variable | Descripción | Valores de Ejemplo |
| :--- | :--- | :--- |
| `MCP_RESOURCE_LIMITS_BACKEND` | Motor de límites a utilizar | `auto` (default), `systemd`, `prlimit`, `none` |
| `MCP_CPU_LIMIT` | Con `%`: cuota, solo systemd. Entero sin sufijo: segundos por proceso, solo prlimit | `50%`, `100%`, `60` |
| `MCP_MEMORY_LIMIT` | systemd: memoria del scope; prlimit: espacio virtual por proceso | `512M`, `1G`, `1073741824` |
| `MCP_PROCESS_LIMIT` | Límite de procesos/tareas | `50`, `100` |
| `MCP_REQUIRE_RESOURCE_LIMITS` | Si es `1`, falla cerrado si no hay motor disponible | `0` (default), `1` |

Los valores deben ser positivos y representables sin perdida de precision; CPU en segundos y procesos deben ser enteros. Memoria admite bytes o unidades binarias K/M/G/T con B opcional. Valores o motores invalidos se rechazan, nunca se omiten silenciosamente.

`auto` solo selecciona un motor compatible con la unidad de CPU solicitada. No convierte porcentajes a segundos. Si hay limites configurados y no puede aplicarlos (incluido `backend=none`), se rechaza la ejecucion incluso sin `MCP_REQUIRE_RESOURCE_LIMITS=1`. Para desactivar limites, quite sus valores y desactive la obligatoriedad. Sin CPU configurada, `auto` puede elegir cualquiera de los motores; fije el motor si necesita una semantica concreta de memoria/procesos.

La deteccion indica disponibilidad del ejecutable/scope y configuracion, no certifica controladores activos ni mide un trabajo en ejecucion. Un fallo del wrapper debe propagarse sin reintentar el comando sin limites.

---

## 4. Plantillas Opt-in

### Plantilla 1: Delegación de cgroups v2 para el usuario (Host Linux)
Para permitir que un usuario sin privilegios controle CPU y memoria en cgroups v2:

```ini
# /etc/systemd/system/user@.service.d/delegate.conf
[Service]
Delegate=cpu memory pids
```
Recargar systemd:
```bash
sudo systemctl daemon-reload
```

### Plantilla 2: Unidad systemd con Límites de Recursos
Si el servidor MCP se ejecuta como servicio persistente (`mcp-local.service`):

```ini
[Unit]
Description=MCP File Server Local Service
After=network.target

[Service]
Type=simple
User=victor
WorkingDirectory=/mnt/hdd4tb/repo/mcp-server
ExecStart=/usr/bin/node mcp-server.js
Restart=on-failure
RestartSec=5

# Directivas de límites de recursos en cgroups v2
MemoryMax=1G
MemoryHigh=800M
CPUQuota=80%
TasksMax=150

[Install]
WantedBy=default.target
```

### Plantilla 3: Variables en archivo `.env`
Para activar límites en las sesiones de trabajo:
```bash
# .env o entorno de ejecución
MCP_RESOURCE_LIMITS_BACKEND=auto
MCP_CPU_LIMIT=50%
MCP_MEMORY_LIMIT=512M
MCP_PROCESS_LIMIT=100
MCP_REQUIRE_RESOURCE_LIMITS=1
```

---

## 5. Pruebas y Diagnóstico

### Diagnóstico de estado
```bash
node lib/runtime-diagnostics.js status
```
La salida incluirá la sección `isolation`:
```json
{
  "isolation": {
    "fileIsolation": { "active": true, "mechanism": "bubblewrap" },
    "networkIsolation": { "active": true, "unshared": true },
    "resourceLimits": {
      "active": true,
      "backend": "systemd",
      "cpuLimit": "50%",
      "memoryLimit": "512M",
      "processLimit": "100"
    }
  }
}
```

### Prueba de fallo cerrado
Si se establece `MCP_REQUIRE_RESOURCE_LIMITS=1` y se fuerza `MCP_RESOURCE_LIMITS_BACKEND=none`, cualquier tarea restringida rechazará la ejecución antes de iniciar el comando, garantizando que ninguna configuración se degrade silenciosamente.
