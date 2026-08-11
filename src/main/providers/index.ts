/**
 * provider 装配。上层只认 `QuoteProvider` 与 `ProviderId`，不 import 具体目录。
 */

import type { HttpClient } from '../net/http'
import { chainLimiters, createLimiter } from '../net/limiter'
import { createEastmoneyProvider } from './eastmoney'
import { createSinaProvider } from './sina'
import { createTencentProvider } from './tencent'
import type { ProviderId, QuoteProvider } from './types'

export const ALL_PROVIDER_IDS: readonly ProviderId[] = ['eastmoney', 'sina', 'tencent']

export interface ProviderFactoryOptions {
  http: HttpClient
  now?: () => number
}

const FACTORIES: Record<ProviderId, (options: ProviderFactoryOptions) => QuoteProvider> = {
  eastmoney: createEastmoneyProvider,
  sina: createSinaProvider,
  tencent: createTencentProvider,
}

export function createProvider(id: ProviderId, options: ProviderFactoryOptions): QuoteProvider {
  return FACTORIES[id](options)
}

export function createAllProviders(options: ProviderFactoryOptions): Record<ProviderId, QuoteProvider> {
  return {
    eastmoney: createEastmoneyProvider(options),
    sina: createSinaProvider(options),
    tencent: createTencentProvider(options),
  }
}

/**
 * 单源并发闸门（docs/03 §2.4：单 provider ≤ 2）。
 * 与全局闸门串联后交给该 provider 的 HttpClient —— 闸门必须在客户端里，
 * 否则 provider 只要多写一处直接请求就能绕过去。
 */
export function perProviderLimited(globalLimiter: Parameters<typeof chainLimiters>[0], perProvider = 2) {
  return chainLimiters(globalLimiter, createLimiter(perProvider))
}

export type {
  ProviderCapabilities,
  ProviderId,
  ProviderRegistryOptions,
  ProviderStatus,
  QuoteProvider,
} from './types'
export { ProviderDataError, UnsupportedCapabilityError } from './shared'
export {
  AllProvidersUnavailableError,
  CROSS_CHECK_TOLERANCE,
  DEFAULT_REGISTRY_OPTIONS,
  ProviderTimeoutError,
  createProviderRegistry,
} from './registry'
export type {
  Capability,
  CalendarDay,
  CrossCheckAlarm,
  HealthSink,
  ProviderRegistry,
  ProviderState,
  RegistryResult,
} from './registry'
