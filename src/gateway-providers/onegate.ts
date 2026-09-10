/**
 * OneGate — this fork's three-way proxy gateway provider.
 *
 * Mode is read fresh from ~/.nanoclaw-onegate/mode on EVERY contribute() call
 * (see onegate-proxy.ts), so switching between onegate/direct/onecli never
 * needs a rebuild or restart:
 *   onegate -> fleet OneGate via local SSH tunnel
 *   direct  -> NO proxy (last resort if both gateways are off)
 *   onecli  -> hosted OneCLI (delegates to the upstream 'onecli' provider,
 *              byte-for-byte its behavior)
 *
 * This is the fork's divergence point from upstream's single-provider
 * default (see CLAUDE.md "Fork divergences" and fork-divergences.test.ts).
 * Registered under kind 'onegate' and selected by default via
 * DEFAULT_GATEWAY_PROVIDER_KIND in index.ts — an install can still force
 * upstream's plain 'onecli' path with NANOCLAW_GATEWAY_PROVIDER=onecli.
 */
import { applyDirectContainerConfig, applyOneGateContainerConfig, readProxyMode } from '../onegate-proxy.js';

import {
  getGatewayProviderFactory,
  registerGatewayProvider,
  type GatewayApprovalSource,
  type GatewayContribution,
} from './gateway-provider-registry.js';
// Side-effect import: guarantees 'onecli' is registered before we delegate to it.
import './onecli.js';

/** The upstream provider this fork falls back to on mode === 'onecli'. */
function onecliProvider() {
  const factory = getGatewayProviderFactory('onecli');
  if (!factory) throw new Error("OneGate mode 'onecli' but the upstream 'onecli' provider is not registered");
  return factory();
}

registerGatewayProvider('onegate', () => ({
  kind: 'onegate',
  async contribute({ key, groupName, capabilities }): Promise<GatewayContribution> {
    const mode = readProxyMode();
    if (mode === 'onegate') {
      return applyOneGateContainerConfig({
        agent: key.agentGroupId,
        containerName: `${key.agentGroupId}-${key.sessionId}`,
        groupScope: key.agentGroupId,
      });
    }
    if (mode === 'direct') {
      return applyDirectContainerConfig({ containerName: `${key.agentGroupId}-${key.sessionId}` });
    }
    // mode === 'onecli': delegate to the upstream provider so this fork's
    // default fallback stays byte-for-byte upstream's own behavior.
    return onecliProvider().contribute({ key, groupName, capabilities });
  },
  // Held-request approvals only ever originate from the OneCLI gateway (the
  // onegate/direct paths have no such flow); delegating unconditionally is
  // harmless when mode isn't 'onecli' since that source simply never fires.
  approvals(): GatewayApprovalSource {
    const source = onecliProvider().approvals?.();
    if (!source) throw new Error("OneGate fallback provider 'onecli' has no approvals source");
    return source;
  },
}));
