export type DetectableAgentAvailability = {
  enabled: boolean;
  terminalDetected?: boolean;
  detected?: boolean;
};

/** The Bot picker is a launcher for ready agents, not an installation surface. */
export function isAgentAvailableForBot(agent: DetectableAgentAvailability): boolean {
  return agent.enabled && agent.terminalDetected === true && agent.detected === true;
}
