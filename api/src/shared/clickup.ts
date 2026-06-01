import { fetchJson } from './http';
import { getSecret } from './secrets';

/**
 * ClickUp API client — pulls active project lists, their tasks, and tracked
 * time. The `deal_id` join key is read from a ClickUp custom field on the list
 * (or on tasks). Token from Key Vault secret `clickup-token`, team id from
 * `clickup-team-id`.
 */

const BASE = 'https://api.clickup.com/api/v2';

// -----------------------------------------------------------------------------
// CONFIGURE THESE before going live (see README §1):
//   DEAL_ID_FIELD — the ClickUp custom-field id that stores the PipeDrive deal id.
//   ACTIVE_TAG     — lists/spaces tagged this way are treated as live engagements.
// -----------------------------------------------------------------------------
export const DEAL_ID_FIELD = 'REPLACE_WITH_DEAL_ID_CUSTOM_FIELD_ID';
export const ACTIVE_TAG = 'active-engagement';

export interface ProjectRow {
  deal_id: number;
  clickup_id: string;
  name: string | null;
  planned_hours: number;
}

export interface TaskRow {
  clickup_task_id: string;
  name: string | null;
  estimate_hours: number;
  logged_hours: number;
  is_closed: boolean;
}

interface ClickUpList {
  id: string;
  name: string;
  archived?: boolean;
  custom_fields?: { id: string; value?: unknown }[];
}

interface ClickUpTask {
  id: string;
  name: string;
  status?: { type?: string };
  time_estimate?: number | null; // milliseconds
  time_spent?: number | null; // milliseconds
  custom_fields?: { id: string; value?: unknown }[];
}

async function authHeaders(): Promise<Record<string, string>> {
  const tok = await getSecret('clickup-token');
  return { Authorization: tok };
}

function readCustomField(
  fields: { id: string; value?: unknown }[] | undefined,
  id: string
): unknown {
  return fields?.find((f) => f.id === id)?.value;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * List active-engagement lists across the team's spaces and map each to a
 * project. We walk Team → Spaces → Folderless Lists + Folders → Lists, then
 * keep lists carrying a deal_id custom field.
 */
export async function pullProjects(): Promise<ProjectRow[]> {
  const headers = await authHeaders();
  const teamId = await getSecret('clickup-team-id');

  const spaces = await fetchJson<{ spaces: { id: string }[] }>(
    `${BASE}/team/${teamId}/space?archived=false`,
    { headers }
  );

  const lists: ClickUpList[] = [];

  for (const space of spaces.spaces ?? []) {
    // Folderless lists
    const folderless = await fetchJson<{ lists: ClickUpList[] }>(
      `${BASE}/space/${space.id}/list?archived=false`,
      { headers }
    );
    lists.push(...(folderless.lists ?? []));

    // Lists inside folders
    const folders = await fetchJson<{ folders: { id: string }[] }>(
      `${BASE}/space/${space.id}/folder?archived=false`,
      { headers }
    );
    for (const folder of folders.folders ?? []) {
      const folderLists = await fetchJson<{ lists: ClickUpList[] }>(
        `${BASE}/folder/${folder.id}/list?archived=false`,
        { headers }
      );
      lists.push(...(folderLists.lists ?? []));
    }
  }

  const projects: ProjectRow[] = [];
  for (const list of lists) {
    if (list.archived) continue;
    const dealRaw = readCustomField(list.custom_fields, DEAL_ID_FIELD);
    const dealId = Number(dealRaw);
    // Only lists carrying a valid deal_id are real engagements.
    if (!Number.isFinite(dealId) || dealId === 0) continue;

    projects.push({
      deal_id: dealId,
      clickup_id: list.id,
      name: list.name ?? null,
      planned_hours: 0, // rolled up from task estimates in pullTasks()
    });
  }

  return projects;
}

/**
 * Paginate all tasks (incl. closed) for a list. Converts ClickUp's millisecond
 * time fields to hours and flags closed tasks for the percent-complete rollup.
 */
export async function pullTasks(listId: string): Promise<TaskRow[]> {
  const headers = await authHeaders();
  const tasks: TaskRow[] = [];
  let page = 0;
  let lastPage = false;

  while (!lastPage) {
    const resp = await fetchJson<{ tasks: ClickUpTask[]; last_page?: boolean }>(
      `${BASE}/list/${listId}/task?include_closed=true&subtasks=true&page=${page}`,
      { headers }
    );

    for (const t of resp.tasks ?? []) {
      tasks.push({
        clickup_task_id: t.id,
        name: t.name ?? null,
        estimate_hours: (t.time_estimate ?? 0) / MS_PER_HOUR,
        logged_hours: (t.time_spent ?? 0) / MS_PER_HOUR,
        is_closed: (t.status?.type ?? '').toLowerCase() === 'closed',
      });
    }

    // ClickUp paginates 100/page; last_page may be absent, so also stop on a
    // short page.
    lastPage = resp.last_page === true || (resp.tasks?.length ?? 0) < 100;
    page++;
  }

  return tasks;
}
