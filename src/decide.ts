export type ContextAction = "skip" | "inject" | "notice";

export interface Decision {
  /** Pi put the file in the system prompt at startup. */
  piLoaded: boolean;
  /** The agent read the file itself with the read tool this session. */
  agentRead: boolean;
  /** This session already handed the file to the agent. */
  injected: boolean;
  /** The copy the agent holds is still in the model's context. */
  live: boolean;
  /** A context event or session boundary has told us what is in context. */
  liveKnown: boolean;
  /** The agent's copy differs from the file on disk. */
  changed: boolean;
}

/**
 * Whether a discovered file needs a message. The agent never gets the same
 * contents twice: a file it already read is never injected, a file whose text
 * moved gets a diff notice instead of a second copy, and a file whose injection
 * a compaction boundary dropped is injected again because the agent no longer
 * has it.
 */
export function decide(d: Decision): ContextAction {
  if (d.piLoaded || d.agentRead) return "skip";
  if (!d.injected) return "inject";
  if (d.live) return d.changed ? "notice" : "skip";
  return d.liveKnown ? "inject" : "skip";
}
