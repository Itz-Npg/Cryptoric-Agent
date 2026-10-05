/**
 * Server-published models, end to end through the gateway.
 *
 * The catalogue module was tested on its own, which proved nothing about the
 * user's actual requirement: that a model published on a server can be
 * *selected* and actually changes the request. These tests close that gap by
 * driving `setCustomModels` → `resolveModel`, which is the exact path
 * `models:select` uses.
 */

import { describe, expect, it } from 'vitest'
import { ModelGateway, PROVIDER_SERVER_CREDENTIAL } from '../../src/main/services/models/gateway'
import type { ModelConfig } from '../../src/main/services/models/gateway'
import { toProviderConfigs } from '../../src/main/services/models/catalogue'

const BASE: ModelConfig = {
  provider: 'none',
  endpoint: '',
  model: 'local-default',
  credentialKey: null,
  dailyBudgetCoins: 25
}

function makeGateway(): ModelGateway {
  return new ModelGateway({
    config: BASE,
    getApiKey: () => null,
    onUsage: () => undefined
  })
}

describe('server-published models', () => {
  it('resolves a published model that was never built in', () => {
    const gateway = makeGateway()
    // Nothing built-in is called this.
    expect(gateway.resolveModel('cryptoric-max')).toBeNull()

    gateway.setCustomModels(
      toProviderConfigs(
        {
          schemaVersion: 1,
          updatedAt: '',
          models: [{ id: 'cryptoric-max', label: 'Max', description: '', contextWindow: 200000, byok: false }]
        },
        'https://models.example.com'
      )
    )

    const resolved = gateway.resolveModel('cryptoric-max')
    expect(resolved).not.toBeNull()
    expect(resolved?.model).toBe('cryptoric-max')
    expect(resolved?.endpoint).toBe('https://models.example.com')
    expect(gateway.hasCustomModels()).toBe(true)
    expect(gateway.listCustomModels()).toContain('cryptoric-max')
  })

  it('prefers a server model over a built-in of the same id', () => {
    const gateway = makeGateway()
    // The operator's server is the authority on what it serves; a stale
    // built-in entry would send the request somewhere they did not choose.
    gateway.setCustomModels([
      { ...BASE, provider: 'openai-compatible', endpoint: 'https://mine.test', model: 'gpt-4o' }
    ])
    const resolved = gateway.resolveModel('gpt-4o')
    expect(resolved?.endpoint).toBe('https://mine.test')
  })

  it('drops models removed from the server rather than merging them', () => {
    const gateway = makeGateway()
    gateway.setCustomModels([
      { ...BASE, provider: 'openai-compatible', endpoint: 'https://mine.test', model: 'a' },
      { ...BASE, provider: 'openai-compatible', endpoint: 'https://mine.test', model: 'b' }
    ])
    expect(gateway.listCustomModels()).toEqual(['a', 'b'])

    // Replacing, not merging: turning a model off on the server must take
    // effect without restarting the app.
    gateway.setCustomModels([
      { ...BASE, provider: 'openai-compatible', endpoint: 'https://mine.test', model: 'a' }
    ])
    expect(gateway.listCustomModels()).toEqual(['a'])
    expect(gateway.resolveModel('b')).toBeNull()
  })

  it('clears cleanly when the server is switched off', () => {
    const gateway = makeGateway()
    gateway.setCustomModels([
      { ...BASE, provider: 'openai-compatible', endpoint: 'https://mine.test', model: 'a' }
    ])
    gateway.setCustomModels([])
    expect(gateway.hasCustomModels()).toBe(false)
    expect(gateway.resolveModel('a')).toBeNull()
    // Built-ins still resolve: clearing the server must not break the app.
    expect(gateway.resolveModel('space-bunny-alpha')).not.toBeNull()
  })

  it('keeps the server token out of the provider credential slots', () => {
    // A server credential sitting where a provider credential is expected is
    // how one key gets sent to the wrong endpoint.
    expect(PROVIDER_SERVER_CREDENTIAL).not.toBe('model-api-key')
    expect(PROVIDER_SERVER_CREDENTIAL).toBe('provider-server-token')
  })

  it('lists custom models in a stable order', () => {
    const gateway = makeGateway()
    gateway.setCustomModels(
      ['zeta', 'alpha', 'mid'].map((m) => ({
        ...BASE,
        provider: 'openai-compatible' as const,
        endpoint: 'https://mine.test',
        model: m
      }))
    )
    // Sorted so the picker does not reshuffle between refreshes.
    expect(gateway.listCustomModels()).toEqual(['alpha', 'mid', 'zeta'])
  })
})
