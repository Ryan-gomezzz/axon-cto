export {
  CRITICAL_PATHS,
  matchesCriticalPath,
  inferServices,
} from './critical-paths.js';
export { handleGitHubPRWebhook } from './realtime.js';
export {
  prDigestJob,
  computeDigestSnapshot,
  buildDigestUserMessage,
  synthesizeDigest,
  formatDigestForTelegram,
} from './digest.js';
export {
  registerPRHealth,
  type QueueLike,
  type SchedulerLike,
  type RegisterPRContext,
} from './register.js';
export type {
  PRContext,
  PRPackageEnv,
  GitHubPRWebhook,
  GatewayWebhookEnvelope,
  PullRequestRow,
  ReviewerBottleneck,
  DigestSnapshot,
} from './types.js';

export const PACKAGE_NAME = '@axon/pr';
