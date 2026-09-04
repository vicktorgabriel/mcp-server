# Diagnóstico OAuth 2.1 del servidor MCP

> Documento técnico de auditoría; no contiene credenciales ni tokens.

Fecha de auditoría: 2026-09-04
Versión corregida: 4.5.3
Estado: **login, token exchange, Bearer y herramientas reales validados; refresh real pendiente**

No se modificaron credenciales OAuth reales ni se inspeccionaron o copiaron
secretos del entorno privado. Este informe todavía no contiene evidencia de una
renovación real iniciada por ChatGPT; publicar el código no debe interpretarse
como cierre completo del incidente. No se preparó tag ni release.

## Resumen ejecutivo

La auditoría encontró cuatro causas principales y varios defectos secundarios de
conformidad y diagnóstico:

1. La pantalla de autorización original permitía que `allow` y `deny`
   pertenecieran al mismo formulario. La evidencia histórica muestra un `deny`
   que consumió la transacción y un `allow` posterior que recibió
   "La autorización venció". El mecanismo es compatible con un submit implícito
   desde un campo de credenciales que eligió el primer submit del formulario.
2. Validar siempre `Origin === issuer` es incompatible con el documento OAuth
   sandboxed observado en ChatGPT, que puede enviar `Origin: null`. `null` no es
   un hostname ni debe aceptarse sin condiciones: ahora sólo se admite junto con
   `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate` y
   `Sec-Fetch-Dest: document`. `Sec-Fetch-User` se registra pero no se exige,
   porque no acompaña obligatoriamente todas las navegaciones.
3. El rebase posterior a operaciones `await` protegía el proceso Node actual,
   pero no dos procesos que escribieran el mismo JSON. Antes de incorporar el
   lock, una reproducción con dos procesos conservó sólo `1/2` clientes. El
   almacenamiento ahora serializa toda mutación mediante un lock privado y
   rechaza snapshots con revisión obsoleta. La prueba multiproceso conserva
   `12/12` mutaciones.
4. La prueba real del 2026-09-04 reveló un bloqueo posterior al login distinto
   de los anteriores. El servidor aceptó las credenciales, consumió la
   transacción, emitió el código y respondió 302 al callback exacto de ChatGPT,
   pero ChatGPT nunca llamó a `/oauth/token`. La CSP del documento sólo permitía
   al issuer en `form-action`; Chromium aplica esa directiva también al destino
   de una redirección originada por el submit y bloqueaba el callback
   cross-origin. Una reproducción aislada mostró el error CSP y no alcanzó el
   callback; al agregar únicamente el origen del redirect registrado, el mismo
   navegador sí lo alcanzó. La CSP ahora permite sólo el issuer y el origen del
   redirect exacto que ya fue validado para esa transacción.

Además se corrigieron el alcance de `offline_access` en los metadatos del
recurso protegido, el desafío Bearer para una solicitud sin credenciales, el
audience de `private_key_jwt` en revocación, la persistencia de la revocación de
familia ante replay, la aceptación de parámetros duplicados y la redacción de
logs.

## Evidencia del último intento real

En dos intentos consecutivos desde ChatGPT, el trazado redactado mostró la misma
secuencia:

1. descubrimiento de recurso y authorization server con HTTP 200;
2. DCR público con HTTP 201;
3. GET `/oauth/authorize` con cliente, callback, state, PKCE S256 y resource
   válidos;
4. POST del formulario desde el documento sandboxed, con `Origin: null` y Fetch
   Metadata `same-origin/navigate/document`;
5. credenciales válidas, code emitido y 302 al host/path correcto de ChatGPT;
6. ningún POST a `/oauth/token`;
7. unos segundos después, repetición del mismo POST del formulario ya
   consumido, que correctamente terminó en HTTP 400.

Esto descarta como causa de esos intentos al transporte MCP, DCR, login, PKCE,
resource binding y token endpoint: este último nunca recibió una solicitud. El
evento histórico "Cliente MCP conectado" correspondía al `initialize` anónimo
de descubrimiento, no a una sesión OAuth. El mensaje ahora distingue
explícitamente ese estado y no lo presenta como conexión autenticada.

Después de aplicar la corrección CSP, reiniciar el runtime y crear una conexión
nueva con **Mixtas**, ChatGPT completó en una prueba real: descubrimiento, DCR
público, autorización con PKCE S256 y resource correcto, POST al token endpoint
con autenticación `none` y respuesta HTTP 200. La interfaz confirmó la cuenta
conectada. A continuación ChatGPT volvió a `/mcp` con Bearer, abrió una sesión
identificada como usuario OAuth y ejecutó `tool_policy_status`: el servidor
devolvió el perfil activo con 72 herramientas visibles. También se observaron
otras herramientas reales ejecutadas mediante la misma sesión. Falta observar
una renovación real para cerrar completamente el incidente.

## Máquina de estados auditada

| Estado | Entrada válida | Mutación persistente | Salida |
|---|---|---|---|
| Descubrimiento | GET de los tres endpoints `/.well-known` | Ninguna | Metadatos de recurso y authorization server |
| Cliente conocido | DCR por JSON, o CIMD si está habilitado | `clients` | `client_id` público o cliente verificado |
| Autorización iniciada | `response_type=code`, cliente, redirect exacto, state, PKCE S256, resource y scopes | `authorizationTransactions` | Formulario con transacción opaca y TTL |
| Cancelación | Formulario `deny` independiente y sin credenciales | consume sólo la transacción | callback `access_denied` con state y, sólo si se anunció, `iss` |
| Autorización aceptada | Formulario `allow`, credenciales válidas y origen admisible | consume transacción y crea `authorizationCodes` en una sola mutación | callback con code, state y `iss` opcional |
| Canje de code | cliente válido, redirect exacto, code, verifier, resource exacto | consume code; crea access token y, si el cliente registró el grant `refresh_token`, refresh token | respuesta token HTTP 200 |
| Recurso MCP | `Authorization: Bearer`, token vigente, audience/resource y `mcp:tools` | Ninguna salvo limpieza de expirados | sesión MCP y ejecución de herramienta |
| Renovación | refresh token activo, mismo cliente/resource y scope no ampliado | rota refresh; marca anterior usado; crea nuevos tokens | nuevo access token y refresh token |
| Replay de refresh | refresh ya usado | revoca toda la familia y persiste incluso al devolver error | `invalid_grant` |
| Revocación | cliente autenticado y token | elimina token o familia | HTTP 200 idempotente |

Los identificadores de códigos, tokens, transacciones y secretos se guardan
como hashes cuando el servidor no necesita recuperar el valor original. El
payload temporal conserva sólo los datos de protocolo necesarios para completar
el callback. Ningún valor emitido se incluye en este informe.

## Mapa de mutaciones de `oauth-state.json`

| Colección | Operaciones | Protección actual |
|---|---|---|
| `admin` | configuración de cuenta | mutación atómica bajo lock |
| `clients` | DCR, caché CIMD, poda | rebase y mutación atómica bajo lock |
| `authorizationTransactions` | alta, allow, cancel, expiración | mutación atómica; allow crea code en la misma sección crítica |
| `authorizationCodes` | emisión y canje único | mutación atómica; PKCE/resource se validan antes de consumir |
| `accessTokens` | emisión, expiración, revocación/familia | mutación atómica bajo lock |
| `refreshTokens` | emisión, rotación, expiración, revocación | mutación atómica bajo lock |
| `usedRefreshTokens` | marca de rotación y detección de reuse | revocación de familia persistida antes de responder error |

La búsqueda final de secuencias `reload/refresh -> await -> save` no encontró
ninguna en los caminos de producción. Los `save()` directos restantes están en
preparación o pruebas y ahora fallan ante una revisión obsoleta.

El archivo mantiene escritura por temporal + rename y permisos `0600`; el
directorio y lock usan permisos privados. `revision` conserva compatibilidad con
el formato versión 1 y evita que `save()` silencie una escritura más nueva.

Esta solución es adecuada para una instancia pequeña en un único host. No
convierte JSON en una base transaccional distribuida: para varias instancias,
contenedores o hosts debe migrarse el estado a un almacén transaccional común o,
preferentemente, delegarse la autorización a un proveedor OAuth maduro.

## Formulario, `Origin: null` y CSRF

La página contiene ahora dos formularios realmente separados:

- `allow-form`: transacción, `decision=allow`, username, password y un único
  submit.
- `deny-form`: transacción, `decision=deny`, sin username/password y con su
  propio submit.

Por construcción, Enter en username/password sólo puede enviar `allow`. El
servidor también rechaza un `deny` contaminado con campos de credenciales y no
consume la transacción. Parámetros críticos repetidos se rechazan.

`Origin: null` es un origen opaco posible en contextos sandboxed o sensibles a
privacidad; no identifica por sí mismo a ChatGPT. La excepción implementada se
limita a una navegación de documento declarada same-origin por Fetch Metadata.
Los encabezados `Sec-Fetch-*` aportan una señal de navegador que JavaScript no
puede establecer directamente, pero no son autenticación criptográfica y un
cliente HTTP no navegador puede falsificarlos. La defensa primaria sigue siendo
la transacción aleatoria de un solo uso y TTL corto, junto con redirect exacto,
state, PKCE S256, resource binding, credenciales y rate limiting. Un Origin
normal continúa exigiendo coincidencia exacta con el issuer; un Origin hostil o
un `null` con metadatos incompletos se rechazan antes de consumir estado.

La CSP permite framing sólo desde `self`, ChatGPT y el origen histórico de
ChatGPT. `form-action` queda limitado al issuer y al origen del redirect URI
exacto previamente registrado y validado. CSP sólo puede restringir por origen,
pero el servidor sigue construyendo el 302 desde el redirect URI exacto guardado
en la transacción; el navegador no controla ese destino ni puede ampliarlo.

Referencias normativas:

- [RFC 6454 - serialización de origen opaco como `null`](https://www.rfc-editor.org/rfc/rfc6454)
- [W3C Fetch Metadata](https://www.w3.org/TR/fetch-metadata/)
- [W3C Content Security Policy Level 3 - `form-action`](https://www.w3.org/TR/CSP3/#directive-form-action)

## Metadatos y desafíos

- `/.well-known/oauth-protected-resource` y
  `/.well-known/oauth-protected-resource/mcp` publican el mismo recurso exacto
  `<issuer>/mcp`, `authorization_servers`, Bearer por header y sólo el scope de
  recurso `mcp:tools`.
- `/.well-known/oauth-authorization-server` publica endpoints reales de
  autorización, token, registro cuando DCR está habilitado y revocación; code,
  authorization_code/refresh_token, PKCE S256 y los métodos de autenticación de
  cliente efectivamente habilitados.
- El authorization server publica `offline_access`; el recurso protegido no.
  Si el cliente registró el grant `refresh_token`, el servidor emite y rota
  refresh tokens. El cliente puede solicitar `offline_access`, pero ese scope
  opcional no es un requisito del recurso `mcp:tools`.
- `client_id_metadata_document_supported` refleja la opción CIMD. DCR sigue
  siendo el camino operativo principal del laboratorio y no se cambió ninguna
  configuración. Como dato nuevo, una consulta pública de sólo lectura hecha
  desde este host el 2026-09-04 devolvió HTTP 200 para el CIMD estable de
  ChatGPT; esto difiere del 404 histórico, pero todavía no prueba qué método
  elegirá el conector real.
- `authorization_response_iss_parameter_supported` sólo aparece cuando la
  opción está activa. En ese modo, tanto éxito como `access_denied` devuelven el
  issuer exacto; con la opción apagada no se depende de `iss`.
- Un HTTP 401 sin Bearer anuncia `resource_metadata` y scope sin afirmar
  `invalid_token`; un token presentado pero inválido sí informa el error. El
  resultado de `tools/call` sin cuenta conserva
  `_meta["mcp/www_authenticate"]` con `invalid_token` y descripción, tal como
  exige la integración de autorización por herramienta de OpenAI. La herramienta
  no se ejecuta en esa rama.

Referencias:

- [OpenAI Plugins - Authentication](https://developers.openai.com/plugins/build/auth)
- [CIMD público actual de ChatGPT](https://chatgpt.com/oauth/client.json)
- [MCP Authorization specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)

## Token endpoint y seguridad de sesión

El canje de authorization code comprueba, antes de emitir tokens:

- `grant_type=authorization_code` y parámetros no duplicados;
- método de autenticación igual al registrado (`none` para cliente público DCR);
- `client_id`, code vigente y de un solo uso;
- `redirect_uri` idéntico al de la autorización;
- verifier con sintaxis válida y PKCE S256 exacto;
- exactamente un `resource`, igual al ligado al code y al MCP.

La renovación comprueba cliente, token, resource y reducción/no ampliación de
scope. Si el cliente registró el grant `refresh_token`, la emisión inicial
incluye un refresh rotativo aunque el cliente haya solicitado sólo `mcp:tools`:
`offline_access` es opcional para el cliente MCP y no es un requisito del
recurso protegido. Cada refresh rota. Reutilizar el anterior revoca la familia completa y
esa revocación se guarda aunque la respuesta sea `invalid_grant`. Revocar un
refresh revoca también su familia. Una reducción explícita del scope de acceso
no corta la rotación: el servidor devuelve el refresh reemplazante porque la
capacidad offline ya fue concedida al emitir el token presentado. En clientes
`private_key_jwt`, token y revoke validan el audience de su endpoint
correspondiente y mantienen detección de replay de assertion.

Se mantienen HTTPS obligatorio fuera de localhost explícitamente permitido,
PKCE S256, códigos y transacciones con TTL, hash scrypt de password, tokens
aleatorios almacenados por hash, límites de solicitudes, resource binding,
redirect exacto, permisos privados y redacción de secretos.

## Diagnóstico HTTP seguro

Cada request OAuth registra una referencia corta independiente, método, path,
IP, clasificación segura de Origin/Referer, Fetch Metadata, Content-Type,
status y host/path del redirect. No registra query strings completas ni valores
de Authorization, Cookie, credenciales, transaction, state, code, PKCE,
assertions, secretos o tokens. Los fallos de login sólo indican si cada factor
fue correcto o incorrecto. El timestamp humano usa ISO 8601 con offset local;
los tiempos internos que requieren epoch/UTC no cambiaron.

## Pruebas ejecutadas

Todos estos comandos terminaron correctamente:

```text
npm test
npm run selftest
npm audit --audit-level=low
git diff --check
curl (sólo status HTTP) al CIMD público estable de ChatGPT
```

`npm test` incluye `node --check`, compilación/sintaxis de Python y shell, más
tests de modos de autenticación, administración OAuth, transacciones, CIMD,
`private_key_jwt`, flujo OAuth end-to-end y setup. Resultado de dependencia:
`0 vulnerabilities`.

La consulta CIMD pública devolvió HTTP 200 desde este host. No imprimió ni
persistió el documento y no cambió el modo DCR configurado.

También se ejecutó una reproducción local con Chromium de la navegación
formulario -> POST -> 302 -> callback cross-origin. Con la CSP anterior el
navegador bloqueó la redirección por `form-action`; con issuer + origen exacto
del callback alcanzó el destino. El fixture fue temporal, no usó estado ni
credenciales reales y se eliminó después de la prueba.

Cobertura OAuth agregada o reforzada:

- DCR público sin secret y CIMD opt-in;
- PKCE S256, redirect y resource exactos;
- allow, cancel limpio, Enter implícito y deny contaminado;
- Origin normal, `Origin: null` condicionado y Origin hostil;
- 12 autorizaciones concurrentes dentro de un proceso;
- 12 mutaciones concurrentes desde procesos distintos;
- canje de code, reuse de code, refresh, rotación, replay y revoke;
- `iss` opcional en éxito y cancelación;
- 401 HTTP y desafío por herramienta;
- ejecución real de `tool_policy_status` con access token y después de refresh;
- CSP de autorización con issuer + callback permitido, sin aceptar un origen
  hostil, incluida la página de reintento por credenciales inválidas;
- redacción y timestamp local.

MCP Inspector pudo listar las herramientas de un servidor aislado y confirmó
que `tool_policy_status` sin autenticación devuelve el desafío por herramienta
sin ejecutarse. Su CLI no sustituyó el navegador ni el conector real de ChatGPT;
por eso no se considera prueba end-to-end de linking.

Referencia: [MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector)

## Secuencia esperada en la prueba real de ChatGPT

Con un conector nuevo y el flujo **Mixtas -> `tool_policy_status` -> Actualizar
acceso**, el log seguro debe mostrar, en orden lógico:

1. GET de protected-resource metadata con salida 200.
2. GET de authorization-server metadata con salida 200.
3. POST de DCR con salida 201, salvo que ChatGPT reutilice un cliente válido.
4. GET `/oauth/authorize` con salida 200 y creación de una transacción.
5. POST `/oauth/authorize`; si el documento está sandboxed, `origin=opaco` y
   Fetch Metadata `same-origin/navigate/document`; decisión `allow`, transacción
   encontrada y salida 302 únicamente al host/path de callback de ChatGPT.
6. POST `/oauth/token` con grant `authorization_code`, cliente público `none`,
   resource correcto y PKCE presente; salida 200 y evento de sesión emitida.
7. Request `/mcp` con Bearer válido, seguido por ejecución y resultado de
   `tool_policy_status`.
8. Más tarde, POST `/oauth/token` con grant `refresh_token`, resource correcto,
   salida 200, y una nueva llamada MCP autenticada.

Interpretación diagnóstica:

- Si no aparece siquiera GET `/oauth/authorize`, el servidor no recibió el
  intento: hay que recrear el conector y revisar la capa de linking de ChatGPT.
  El error histórico de deserialización de un registro viejo pertenece a esa
  capa y no se intentó "corregir" dentro del MCP.
- Si no aparece el POST `/oauth/token` después del 302, el fallo está entre el
  callback y ChatGPT, no en el token endpoint.
- Si aparece con 4xx, el resumen redactado diferencia cliente, grant, resource,
  PKCE y categoría de rechazo.
- Si devuelve 200 pero nunca aparece Bearer en `/mcp`, ChatGPT obtuvo tokens pero
  no usó la sesión para el recurso.
- Si Bearer llega y la herramienta responde, el linking inicial está demostrado.
  Aún falta observar una renovación real para cerrar persistencia de sesión.

## Archivos del worktree involucrados

- `lib/oauth-provider.js`: formularios, Origin, metadata/challenges, almacenamiento,
  CSP de callback, token/revoke y trazado.
- `mcp-server.js`: distingue descubrimiento anónimo de una conexión OAuth
  autenticada en el log humano.
- `oauth-admin.js`: reset bajo mutación atómica.
- `lib/human-log.js`: timestamp ISO local y redacción ampliada.
- `tests/oauth-transaction-self-test.js`: formulario, origen, doble submit,
  cancelación e `iss`.
- `tests/oauth-state-concurrency-self-test.js`: nueva prueba multiproceso.
- `tests/oauth-self-test.js`: metadata, code/PKCE/resource, herramienta real, refresh,
  replay, revoke y logs.
- `tests/oauth-private-key-jwt-self-test.js`: audience de revocación.
- `tests/local-time-self-test.js`: timestamp y secretos redactados.
- `package.json` y `package-lock.json`: incorporación de las pruebas y versión
  4.5.3.
- `tests/access-policy-self-test.js`, `tests/auth-mode-self-test.js`,
  `tests/extended-tools-self-test.js` y `self-test.sh`: aislamiento de las pruebas
  frente a la configuración persistente real, sin modificarla.
- `docs/OAUTH_DIAGNOSTICO.md`: este informe.

Los módulos internos se agruparon en `lib/`, los self-tests individuales en
`tests/` y la documentación técnica en `docs/`. La raíz conserva los entrypoints
y scripts operativos para no alterar el uso cotidiano ni el servicio systemd.

Los artefactos temporales de aplicación en vivo (`*-lab.js`, scripts específicos
del laboratorio y el tar de traslado), tres logs heredados de la raíz y el `__pycache__` generado
se enviaron a la papelera de forma recuperable después de confirmar que no eran
consumidos por el runtime vigente. Se conservaron los self-tests y este
diagnóstico. No se tocaron `.env`, `.private` ni los secretos locales.

## Riesgos pendientes y recomendación

1. **Riesgo alto pendiente:** falta observar el uso real del refresh token por
   ChatGPT. Hasta entonces no debe afirmarse que el incidente está completamente
   resuelto. Ya quedaron demostrados el runtime corregido, token exchange HTTP
   200, Bearer sobre `/mcp` y `tool_policy_status` autenticado.
2. CIMD permanece opcional y ahora falla de forma segura: un documento HTTP 200
   válido funciona, pero un error/404 no crea ni autoriza al cliente. DCR sigue
   siendo el camino predeterminado y validado con ChatGPT.
3. El lock JSON sirve para un host y filesystem local. Rate limit, caché JWKS y
   replay de client assertions siguen siendo memoria de proceso; múltiples
   réplicas requerirían estado compartido.
4. Los encabezados Fetch Metadata son defensa en profundidad, no identidad de
   ChatGPT. La excepción opaca debe conservar sus tres condiciones y sus tests.
5. La corrección CSP ya quedó confirmada en la superficie real de ChatGPT con
   POST `/oauth/token` 200, Bearer posterior y una herramienta real. Sólo falta
   observar una renovación real desde esa misma conexión.

Recomendación: mantener temporalmente este authorization server propio para el
laboratorio y la prueba de un solo host, porque una migración ahora agregaría
variables y no demostraría la causa del linking. Para exposición pública,
multiusuario o múltiples instancias, migrar la función de authorization server a
un proveedor OAuth/OIDC maduro. El SDK TypeScript MCP actual ayuda en la capa de
resource server, pero su versión v2 no pretende ser un authorization server; los
helpers de authorization server de v1 están congelados. Por tanto, no conviene
introducir una dependencia grande del SDK esperando que reemplace al proveedor.

Referencia: [SDK MCP TypeScript - autorización](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
