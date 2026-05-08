import { escapeMarkdownV2 } from '@axon/shared';

function istHourMinute(d: Date): string {
  // en-IN with hour12:false reliably gives HH:mm in Asia/Kolkata.
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Wrap the LLM-produced brief in MarkdownV2-safe content plus a footer.
 * The brief body is treated as plain text — every special is escaped — so
 * any `* `, `_`, `.` etc. produced by the model survives Telegram's parser.
 * The footer is rendered in italic via explicit `_..._` markers around an
 * already-escaped substring; callers should pass `{ skipEscape: true }` to
 * `TelegramClient.send` because we've already done the escaping here.
 */
export function formatForTelegram(
  brief: string,
  traceId: string,
  generatedAt: Date,
): string {
  const safeBody = escapeMarkdownV2(brief.trim());
  const stamp = `Generated at ${istHourMinute(generatedAt)} IST · trace ${traceId}`;
  const safeFooter = `_${escapeMarkdownV2(stamp)}_`;
  return `${safeBody}\n\n${safeFooter}`;
}
