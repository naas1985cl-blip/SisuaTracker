# Plan de conexión — PipeDrive & ClickUp

Este documento es la guía paso a paso para preparar **PipeDrive** y **ClickUp**
de modo que la aplicación pueda leerlos. El objetivo es que `deal_id` (el id de
deal de PipeDrive) fluya por las tres fuentes y que el sync semanal encuentre los
campos que el código espera.

> **Regla de oro:** `deal_id` es la clave de unión sagrada. Todo deal de
> PipeDrive, toda factura y toda lista de ClickUp debe poder resolverse a un
> `deal_id`. Sin eso, la fila se descarta en el sync.

Al terminar tendrás cinco valores que se cargan en el código / Key Vault:

| Valor | Dónde se usa | Tipo |
|---|---|---|
| `pipedrive-token` | Key Vault | API token de PipeDrive |
| `SOLD_HOURS_FIELD` | `api/src/shared/pipedrive.ts` | clave (hash 40 car.) del campo personalizado |
| `INVOICING_PIPELINE_ID` | `api/src/shared/pipedrive.ts` | id numérico del pipeline de facturación |
| `clickup-token` | Key Vault | API token de ClickUp |
| `clickup-team-id` | Key Vault | id del workspace/team de ClickUp |
| `DEAL_ID_FIELD` | `api/src/shared/clickup.ts` | id (UUID) del campo personalizado |

---

## Parte A — PipeDrive

### A1. Crear / obtener el API token

1. Inicia sesión en PipeDrive con un usuario **admin** (idealmente una cuenta de
   servicio, no personal, para que el token no muera si alguien se va).
2. Ve a **Settings → Personal preferences → API** (o `Company settings → API` en
   planes Advanced+).
3. Copia el **API token**. Es el valor que irá al secreto `pipedrive-token`.
4. Verifícalo rápidamente:
   ```bash
   curl "https://api.pipedrive.com/api/v2/deals?limit=1&api_token=TU_TOKEN"
   ```
   Debe devolver `{"success":true,...}`.

> El código usa la **API v2** con paginación por cursor y `updated_since` para
> pulls incrementales (ver `pullDeals`/`pullInvoices`). El token v1/v2 es el mismo.

### A2. Pipeline de ventas — el campo "Sold hours"

El sync lee de cada deal: `title`, `value` (→ `contract_value`) y un campo
personalizado de **horas vendidas/presupuestadas** (→ `sold_hours`).

1. Ve a **Settings → Data fields → Deal**.
2. Crea (o identifica) un campo personalizado **numérico** llamado, p. ej.,
   `Sold Hours` / `Horas vendidas`.
3. Obtén su **clave** (hash de 40 caracteres). Dos formas:
   - En la pantalla de edición del campo, la clave aparece en la URL / panel de
     detalles del campo.
   - Vía API:
     ```bash
     curl "https://api.pipedrive.com/api/v1/dealFields?api_token=TU_TOKEN" \
       | jq '.data[] | {key, name}'
     ```
     Busca el `key` cuyo `name` sea tu campo de horas.
4. Pon ese valor en `api/src/shared/pipedrive.ts`:
   ```ts
   export const SOLD_HOURS_FIELD = '<hash_de_40_caracteres>';
   ```
5. **Llena el campo en los deals activos.** Si está vacío, `sold_hours = 0`.

### A3. Pipeline de facturación — las facturas

El sync trata cada deal del **pipeline de facturación** como una factura:
`value` → `amount`, estado → `invoice_status`, mes de creación → `period_month`,
y **debe** resolver el `deal_id` del deal de ventas original.

1. Identifica (o crea) un **pipeline dedicado a facturación** en
   **Settings → Pipelines**. Si ya facturas dentro del mismo pipeline de ventas,
   crea uno aparte para no mezclar señales.
2. Obtén su **id numérico**:
   ```bash
   curl "https://api.pipedrive.com/api/v2/pipelines?api_token=TU_TOKEN" \
     | jq '.data[] | {id, name}'
   ```
3. Pon ese id en `api/src/shared/pipedrive.ts`:
   ```ts
   export const INVOICING_PIPELINE_ID = <id_numerico>;
   ```
4. **Conecta cada factura con su deal de ventas.** El código busca el `deal_id`
   en este orden: `origin_deal_id` → `related_deal_id` → `id` propio del deal de
   factura. Recomendado: crea en el deal de facturación un campo personalizado
   numérico **"Origin Deal ID"** y rellénalo con el id del deal de ventas. Si lo
   haces así, ajusta el mapeo en `pullInvoices` para leer la clave de ese campo
   (en vez de `origin_deal_id`), igual que con `SOLD_HOURS_FIELD`.
5. **Mapeo de estados** (`mapInvoiceStatus`): el código mapea
   `paid/won → paid`, `sent/open → sent`, `overdue → overdue`,
   `lost/deleted → void`, resto `→ draft`. Si tus etapas/estados tienen otros
   nombres, ajusta ese `switch`.

### A4. Mes contable (`period_month`)

`period_month` se calcula como el **primer día del mes** de `add_time`
(o `update_time`) del deal de factura. Si tu mes contable se rige por otra fecha
(p. ej. fecha de emisión en un campo propio), ajusta `firstOfMonth(...)` en
`pullInvoices`.

### A5. Checklist PipeDrive

- [ ] Token de API creado y verificado → secreto `pipedrive-token`.
- [ ] Campo "Sold Hours" creado, su `key` → `SOLD_HOURS_FIELD`, y poblado en deals activos.
- [ ] Pipeline de facturación creado, su id → `INVOICING_PIPELINE_ID`.
- [ ] Cada deal de factura referencia el `deal_id` del deal de ventas (campo "Origin Deal ID").
- [ ] Estados de factura mapeados a `invoice_status`.

---

## Parte B — ClickUp

### B1. Crear / obtener el API token

1. Usa una cuenta con acceso a todos los espacios relevantes (idealmente cuenta
   de servicio).
2. Personal token: **Settings → Apps → API Token** → genera un token `pk_...`.
   - *(Alternativa empresarial: crear una OAuth app; para el MVP basta el token
     personal.)*
3. Es el valor del secreto `clickup-token`.

### B2. Obtener el Team / Workspace ID

```bash
curl -H "Authorization: TU_TOKEN" "https://api.clickup.com/api/v2/team" \
  | jq '.teams[] | {id, name}'
```

El `id` del workspace correcto → secreto `clickup-team-id`.

### B3. Campo personalizado "Deal ID" en las listas

Cada **lista** de ClickUp representa un proyecto/engagement y debe portar el
`deal_id` en un campo personalizado. El sync (`pullProjects`) recorre
Team → Spaces → listas (sueltas y dentro de folders) y **solo conserva las listas
cuyo campo `DEAL_ID_FIELD` tiene un número válido**.

1. Crea un **Custom Field numérico** llamado `Deal ID` y aplícalo a las listas de
   proyectos activos. (En ClickUp los custom fields se definen a nivel de lista/
   space; asegúrate de que esté presente en cada lista de engagement.)
2. **Rellena el `deal_id`** (el id del deal de ventas de PipeDrive) en cada lista.
3. Obtén el **id del campo** (UUID). Vía API, sobre una lista de ejemplo:
   ```bash
   curl -H "Authorization: TU_TOKEN" \
     "https://api.clickup.com/api/v2/list/LIST_ID/field" \
     | jq '.fields[] | {id, name, type}'
   ```
   Toma el `id` del campo cuyo `name` sea `Deal ID`.
4. Ponlo en `api/src/shared/clickup.ts`:
   ```ts
   export const DEAL_ID_FIELD = '<uuid_del_campo>';
   ```

> **Nota sobre el campo en listas vs. tareas:** el código lee el campo a nivel de
> **lista** (`list.custom_fields`). La API estándar de ClickUp suele exponer
> custom fields a nivel de **tarea**. Decide tu convención (ver "Decisión
> pendiente" abajo): lo más robusto es poner el `Deal ID` en una **tarea
> "ancla"** o leerlo de la primera tarea de la lista. Si eliges esa vía, hay que
> ajustar `pullProjects` para resolver el `deal_id` desde una tarea.

### B4. Horas y % de avance

El rollup en `pullTasks` + `syncClickUp` calcula:
- `planned_hours = Σ time_estimate` de las tareas (en horas; ClickUp da ms).
- `actual_hours = Σ time_spent` (time tracking).
- `percent_complete = tareas cerradas / total × 100` (status type `closed`).

Acciones en ClickUp:
1. **Activa Time Tracking** y haz que el equipo registre tiempo en las tareas
   (de ahí sale `actual_hours`).
2. **Pon Time Estimates** en las tareas (de ahí sale `planned_hours`). Si
   prefieres usar `sold_hours` de PipeDrive como presupuesto, podemos cambiar el
   rollup para no sobrescribir `planned_hours`.
3. Usa estados cuyo **tipo** sea `closed` para las tareas terminadas (no solo un
   estado custom "Done" que siga siendo tipo `open`), para que el % de avance sea
   correcto.

### B5. Checklist ClickUp

- [ ] Token de API generado → secreto `clickup-token`.
- [ ] Team/Workspace id → secreto `clickup-team-id`.
- [ ] Custom field `Deal ID` creado en las listas de proyectos y **poblado**.
- [ ] `id` del campo `Deal ID` → `DEAL_ID_FIELD`.
- [ ] Time tracking activo + estimates cargados + estados terminales de tipo `closed`.

---

## Parte C — Cargar credenciales y desplegar

1. **Sube los tokens a Key Vault** (ver README §1.2):
   ```bash
   az keyvault secret set --vault-name $KV --name pipedrive-token --value "<...>"
   az keyvault secret set --vault-name $KV --name clickup-token   --value "<...>"
   az keyvault secret set --vault-name $KV --name clickup-team-id --value "<...>"
   ```
2. **Commitea las constantes** ya rellenadas (`SOLD_HOURS_FIELD`,
   `INVOICING_PIPELINE_ID`, `DEAL_ID_FIELD`) y haz push a `main` para desplegar.
3. **Prueba el sync sin esperar al domingo:** Azure Portal → Function App →
   `syncWeekly` → **Code+Test → Test/Run**. Es idempotente.
4. **Verifica** en la base de datos:
   ```sql
   SELECT source, status, records_read, records_upserted, error_detail
   FROM sync_log ORDER BY started_at DESC LIMIT 10;
   SELECT finalize_week();   -- debe decir OK si las 3 fuentes corrieron
   SELECT * FROM v_project_dashboard;
   ```

---

## Parte D — Validación de la unión por `deal_id`

Tras el primer sync, corre estas comprobaciones para detectar uniones rotas:

```sql
-- Proyectos de ClickUp sin deal correspondiente en PipeDrive (no debería haber)
SELECT p.clickup_id, p.deal_id
FROM projects p LEFT JOIN deals d ON d.deal_id = p.deal_id
WHERE d.deal_id IS NULL;

-- Facturas sin deal padre (se descartan en el sync por seguridad de FK)
-- Si esperabas facturas y no aparecen, revisa el mapeo de origin_deal_id.
SELECT count(*) FROM invoices i
LEFT JOIN deals d ON d.deal_id = i.deal_id WHERE d.deal_id IS NULL;

-- Deals sin proyecto en ClickUp (engagement aún no abierto, o falta Deal ID)
SELECT d.deal_id, d.title
FROM deals d LEFT JOIN projects p ON p.deal_id = d.deal_id
WHERE p.deal_id IS NULL;
```

---

## Decisiones pendientes (requieren tu confirmación)

Estas afectan al código de los clientes y conviene definirlas antes del primer
sync real:

1. **`deal_id` en ClickUp: ¿a nivel de lista o de tarea?** El código hoy lo lee
   de la lista; la API de ClickUp normalmente expone custom fields por tarea.
2. **`planned_hours`: ¿estimates de ClickUp o `sold_hours` de PipeDrive?** Hoy se
   toma de los time-estimates de ClickUp.
3. **`Origin Deal ID` en facturas:** ¿usarás un campo personalizado dedicado (lo
   recomendado) o las facturas viven en el mismo deal de ventas?

Dime cuál opción quieres en cada punto y ajusto los mapeos en
`pipedrive.ts` / `clickup.ts`.
