// Eagerly-safe surface — no env access. Boot code that needs env or logger
// should import them explicitly from '@axon/shared/env' / '@axon/shared/logger'.
export { PACKAGE_NAME } from './meta.js';
export { newTraceId, withTrace, currentTrace } from './trace.js';
export {
  TelegramClient,
  escapeMarkdownV2,
  type InlineButton,
  type MessageRef,
  type SendOptions,
  type EditOptions,
  type CallbackContext,
  type CallbackHandler,
  type PollingDriver,
} from './telegram.js';

// env/logger are intentionally NOT re-exported from the barrel. Importing them
// would force every consumer (and every test) to satisfy the env Zod schema at
// module load. Use `import { env } from '@axon/shared/env'` from boot code.
