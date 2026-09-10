/**
 * Regression guards for this fork's intentional divergences from upstream
 * nanocoai/nanoclaw. See the "Fork divergences" section at the top of CLAUDE.md.
 *
 * WHY THIS FILE EXISTS SEPARATELY, rather than living beside the code it guards:
 *
 * An upstream merge conflicts in `src/container-runner.ts` and
 * `src/channels/chat-sdk-bridge.ts`. Resolving either with "take theirs"
 * compiles, typechecks, and passes the rest of the suite while silently
 * deleting the feature. The tests that would have caught it sit in files that
 * ALSO diverge (`chat-sdk-bridge.test.ts` is ~385 lines off upstream), so the
 * same careless resolution removes the guard and its test together.
 *
 * This path does not exist upstream. A merge therefore produces no conflict
 * here, the file survives untouched, and these tests fail loudly instead.
 * Do not merge these cases into the neighbouring test files — the isolation
 * IS the mechanism.
 */
import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './channels/chat-sdk-bridge.js';
import { mergeMounts } from './container-runner.js';
import type { GatewayContribution, GatewayProviderInput } from './gateway-providers/gateway-provider-registry.js';
import { getGatewayProviderFactory, registerGatewayProvider } from './gateway-providers/gateway-provider-registry.js';
import type { MountSpec } from './drivers/types.js';
// Side-effect import: registers 'onegate' against the real onecli spy below.
// (Module evaluation order follows the import graph, not this statement's
// textual position, so this runs before the describe blocks either way —
// kept up here with the other imports for readability.)
import './gateway-providers/onegate.js';

vi.mock('./webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

const proxyMock = vi.hoisted(() => ({
  readProxyMode: vi.fn<() => 'onecli' | 'onegate' | 'direct'>(),
  applyOneGateContainerConfig: vi.fn(),
  applyDirectContainerConfig: vi.fn(),
}));
vi.mock('./onegate-proxy.js', () => proxyMock);

// The real onecli.js talks to the hosted OneCLI SDK. This suite only cares
// that the mode switch delegates to whatever is registered under 'onecli' —
// OneCLI's own wiring is covered by gateway-providers/onecli.test.ts — so
// stub the module and register a spy in its place, registered once below
// (module load, before onegate.js's own side-effect import of onecli.js runs).
vi.mock('./gateway-providers/onecli.js', () => ({}));

const onecliContribution: GatewayContribution = { env: { STUB: 'onecli' } };
const onecliContribute = vi.fn(async () => onecliContribution);
registerGatewayProvider('onecli', () => ({ kind: 'onecli', contribute: onecliContribute }));

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf-8');
}

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('fork divergence: best-effort reactions (behavioral)', () => {
  // Upstream has a bare `await adapter.addReaction(...)`. A platform that
  // rejects an emoji (Telegram's reaction set is a fixed allow-list) then
  // throws out of deliver(), which delivery.ts counts as a delivery failure:
  // three retries, then markDeliveryFailed on a row that is purely cosmetic.
  it('does not throw when the platform rejects the reaction', async () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        name: 'telegram',
        addReaction: async () => {
          throw new Error('Bad Request: REACTION_INVALID');
        },
      } as unknown as Partial<Adapter>),
      supportsThreads: false,
    });

    await expect(
      bridge.deliver('telegram:42', null, {
        kind: 'chat-sdk',
        content: { operation: 'reaction', messageId: '123:456', emoji: 'white_check_mark' },
      }),
    ).resolves.toBeUndefined();
  });

  it('still applies a reaction the platform accepts', async () => {
    const applied: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        name: 'telegram',
        addReaction: async (_t: string, _m: string, emoji: string) => {
          applied.push(emoji);
        },
      } as unknown as Partial<Adapter>),
      supportsThreads: false,
    });

    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'reaction', messageId: '123:456', emoji: 'eyes' },
    });

    expect(applied).toEqual(['eyes']);
  });
});

describe('fork divergence: OneGate proxy switch (behavioral)', () => {
  // Post-driver-seam, the switch is a registered GatewayProvider
  // (src/gateway-providers/onegate.ts) rather than raw argv assembly in
  // container-runner.ts. These drive its contribute() for real, the same
  // shift container-runner.test.ts made for its own former source-text
  // assertions (see that file's header comment).

  const input: GatewayProviderInput = {
    key: { installSlug: 'nanogate', agentGroupId: 'group-1', sessionId: 'session-1' },
    groupName: 'Test Group',
    capabilities: { sharedNetworkNamespace: true, auxiliaryContainers: false } as GatewayProviderInput['capabilities'],
  };

  const onegateContribution: GatewayContribution = { env: { HTTPS_PROXY: 'http://onegate' } };
  const directContribution: GatewayContribution = { env: { ANTHROPIC_API_KEY: 'direct-key' } };

  // 'onecli' is registered once at module load, above (before the static
  // import of gateway-providers/onegate.js), since the registry has no
  // reset seam and throws on a duplicate registerGatewayProvider('onecli', ...).
  beforeEach(() => {
    vi.clearAllMocks();
    proxyMock.applyOneGateContainerConfig.mockReturnValue(onegateContribution);
    proxyMock.applyDirectContainerConfig.mockReturnValue(directContribution);
  });

  it.each([
    ['onegate', () => onegateContribution, () => proxyMock.applyOneGateContainerConfig],
    ['direct', () => directContribution, () => proxyMock.applyDirectContainerConfig],
  ] as const)('routes mode %s to its own contribution, and only that one', async (mode, expected, spy) => {
    proxyMock.readProxyMode.mockReturnValue(mode);
    const provider = getGatewayProviderFactory('onegate')!();

    const result = await provider.contribute(input);

    expect(result).toBe(expected());
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(onecliContribute).not.toHaveBeenCalled();
    const otherSpy = mode === 'onegate' ? proxyMock.applyDirectContainerConfig : proxyMock.applyOneGateContainerConfig;
    expect(otherSpy).not.toHaveBeenCalled();
  });

  it('falls back to the upstream OneCLI provider when mode is "onecli", and only that path', async () => {
    proxyMock.readProxyMode.mockReturnValue('onecli');
    const provider = getGatewayProviderFactory('onegate')!();

    const result = await provider.contribute(input);

    expect(result).toBe(onecliContribution);
    expect(onecliContribute).toHaveBeenCalledTimes(1);
    expect(proxyMock.applyOneGateContainerConfig).not.toHaveBeenCalled();
    expect(proxyMock.applyDirectContainerConfig).not.toHaveBeenCalled();
  });

  it('gateway-contributed mounts (e.g. the OneGate CA stub) shadow a composed mount at the same path', () => {
    // The old raw-argv switch relied on running after the volume-mount loop
    // so a credential stub nested inside one of our RW mounts wasn't
    // shadowed by its parent bind. composeSessionSpec's mergeMounts is the
    // typed-spec successor to that ordering trick: contributed mounts always
    // win a containerPath collision, regardless of call order.
    const composed: MountSpec[] = [
      {
        class: 'allowlisted-extra',
        hostPath: '/host/parent',
        containerPath: '/etc/onegate/rootCA.pem',
        mode: 'rw',
        groupScope: 'group-1',
      },
    ];
    const contributed: MountSpec[] = [
      {
        class: 'allowlisted-extra',
        hostPath: '/host/onegate-ca',
        containerPath: '/etc/onegate/rootCA.pem',
        mode: 'ro',
        groupScope: 'group-1',
      },
    ];

    expect(mergeMounts(composed, contributed)).toEqual(contributed);
  });

  it('keeps the fork-only proxy module', () => {
    const src = readSource('src', 'onegate-proxy.ts');
    expect(src).toContain('export function readProxyMode');
    expect(src).toContain('export function applyOneGateContainerConfig');
    expect(src).toContain('export function applyDirectContainerConfig');
  });
});
