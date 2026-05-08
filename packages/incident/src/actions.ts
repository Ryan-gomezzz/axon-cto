import { Octokit } from '@octokit/rest';
import { escapeMarkdownV2, type MessageRef } from '@axon/shared';
import type { IncidentJobContext } from './types.js';

/**
 * Phase-4 acknowledged-incident state. We can't put this on the Incident
 * payload (CLAUDE.md's schema doesn't include `metadata`), so we keep an
 * in-memory map. State resets across gateway restarts; that's acceptable for
 * the demo and doesn't lose anything material.
 */
interface AckRecord {
  by: string;
  at: number;
}
const ackedIncidents = new Map<string, AckRecord>();

/** Reset for tests. Not part of the public API. */
export function _resetIncidentMutableState(): void {
  ackedIncidents.clear();
  rolledBackDeploys.clear();
}

const rolledBackDeploys = new Set<string>();

interface ActionResult {
  ok: boolean;
  /** Public-facing message — safe to put in Telegram. */
  message: string;
}

function octokitOf(ctx: IncidentJobContext): Octokit {
  return ctx.octokit ?? new Octokit({ auth: ctx.env.GITHUB_TOKEN });
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, ...rest] = repo.split('/');
  if (!owner || rest.length === 0) {
    throw new Error(`actions: invalid repo "${repo}"`);
  }
  return { owner, name: rest.join('/') };
}

/**
 * Phase-4 rollback flow: open a labelled GitHub Issue against the service
 * repo (true PR-revert flow needs a generated revert commit; that's wired
 * later). Idempotent on (repo, sha): existing label-tagged issues for the
 * same SHA are reused instead of creating a duplicate.
 */
export async function rollback(
  incidentId: string,
  deploySha: string | undefined,
  byUser: string,
  ctx: IncidentJobContext,
  ref: MessageRef,
): Promise<ActionResult> {
  if (!deploySha) {
    const text = '↩ Rollback: no deploy SHA was attached to this incident.';
    await replyOrEdit(ctx, ref, text);
    return { ok: false, message: text };
  }
  if (rolledBackDeploys.has(deploySha)) {
    const text = `↩ Rollback already initiated for ${deploySha.slice(0, 8)}.`;
    await replyOrEdit(ctx, ref, text);
    return { ok: true, message: text };
  }
  const incident = ctx.kg.getNode(incidentId, 'Incident');
  const service =
    incident && ctx.kg.getNode(incident.payload.service_id, 'Service');
  if (!service) {
    const text = '↩ Rollback failed: incident or service not found.';
    await replyOrEdit(ctx, ref, text);
    return { ok: false, message: text };
  }

  try {
    const octokit = octokitOf(ctx);
    const { owner, name: repo } = parseRepo(service.payload.repo);
    const title = `Revert deploy ${deploySha.slice(0, 8)}`;

    // Idempotency check on the GitHub side: existing axon-rollback issue with
    // matching SHA in the title.
    const existing = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: 'axon-rollback',
      state: 'open',
      per_page: 50,
    });
    let issue = existing.data.find((i) =>
      i.title.includes(deploySha.slice(0, 8)),
    );
    if (!issue) {
      const created = await octokit.issues.create({
        owner,
        repo,
        title,
        body: `Triggered by Axon for incident \`${incidentId}\`.\n\nRollback target: \`${deploySha}\`\nRequested by: ${byUser}\n\n_This issue is opened by Axon's incident-commander rollback action. CI/CD should pick up the \`axon-rollback\` label._`,
        labels: ['axon-rollback'],
      });
      issue = created.data;
    }
    rolledBackDeploys.add(deploySha);
    const text = `↩ Rollback issue ${issue.html_url}`;
    await replyOrEdit(ctx, ref, text);
    return { ok: true, message: text };
  } catch (err) {
    ctx.log.error(
      {
        component: 'incident',
        stage: 'rollback',
        incidentId,
        deploySha,
        err: err instanceof Error ? err.message : String(err),
      },
      'rollback failed',
    );
    const text = `↩ Rollback failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    await replyOrEdit(ctx, ref, text);
    return { ok: false, message: text };
  }
}

export async function acknowledge(
  incidentId: string,
  byUser: string,
  ctx: IncidentJobContext,
  ref: MessageRef,
): Promise<ActionResult> {
  const existing = ackedIncidents.get(incidentId);
  if (existing) {
    const text = `✓ Already acknowledged by ${existing.by}.`;
    await replyOrEdit(ctx, ref, text);
    return { ok: true, message: text };
  }
  ackedIncidents.set(incidentId, { by: byUser, at: Date.now() });
  const text = `✓ Acknowledged by ${byUser}.`;
  await replyOrEdit(ctx, ref, text);
  return { ok: true, message: text };
}

export async function escalate(
  incidentId: string,
  byUser: string,
  ctx: IncidentJobContext,
  ref: MessageRef,
): Promise<ActionResult> {
  const target = ctx.env.TELEGRAM_ESCALATION_CHAT_ID;
  if (!target) {
    const text = '↑ Escalate failed: TELEGRAM_ESCALATION_CHAT_ID not configured.';
    await replyOrEdit(ctx, ref, text);
    return { ok: false, message: text };
  }
  const incident = ctx.kg.getNode(incidentId, 'Incident');
  if (!incident) {
    const text = '↑ Escalate failed: incident not found.';
    await replyOrEdit(ctx, ref, text);
    return { ok: false, message: text };
  }
  const service = ctx.kg.getNode(incident.payload.service_id, 'Service');
  const summary = `↑ ESCALATION from ${byUser}: ${incident.payload.severity} on ${service?.payload.name ?? incident.payload.service_id} — "${incident.payload.title}". Original incident: ${incidentId}.`;
  await ctx.telegram.send(summary, { chatId: target });
  const text = `↑ Escalated to ${target}.`;
  await replyOrEdit(ctx, ref, text);
  return { ok: true, message: text };
}

async function replyOrEdit(
  ctx: IncidentJobContext,
  ref: MessageRef,
  text: string,
): Promise<void> {
  // Best-effort thread-style follow-up: send a fresh message to the same chat
  // with a quote-style prefix. (True Telegram threads need reply_to_message_id;
  // not exposed yet on TelegramClient, so we just send to the chat.)
  try {
    const safe = `> ${escapeMarkdownV2(text)}`;
    await ctx.telegram.send(safe, { chatId: ref.chatId, skipEscape: true });
  } catch (err) {
    ctx.log.warn(
      {
        component: 'incident',
        stage: 'reply',
        err: err instanceof Error ? err.message : String(err),
      },
      'reply failed',
    );
  }
}

export interface CallbackRouteCtx {
  callbackQueryId: string;
  fromUserHandle: string;
  message?: MessageRef;
}

/** Route a `callback_data` string into the right action. */
export async function dispatchCallback(
  data: string,
  cb: CallbackRouteCtx,
  ctx: IncidentJobContext,
): Promise<ActionResult | { ok: false; message: string }> {
  if (!cb.message) {
    return { ok: false, message: 'callback without message ref' };
  }
  const [action, incidentId, ...rest] = data.split(':');
  if (!action || !incidentId) {
    return { ok: false, message: `unrecognised callback "${data}"` };
  }
  switch (action) {
    case 'rollback':
      return rollback(incidentId, rest[0], cb.fromUserHandle, ctx, cb.message);
    case 'ack':
      return acknowledge(incidentId, cb.fromUserHandle, ctx, cb.message);
    case 'escalate':
      return escalate(incidentId, cb.fromUserHandle, ctx, cb.message);
    default:
      return { ok: false, message: `no handler for action "${action}"` };
  }
}
