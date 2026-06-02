import type { NarrativeEvent, ScenarioPack } from "./types.js";

export class NarrativeGraph {
  public constructor(private readonly pack: ScenarioPack) {}

  public listEvents(): NarrativeEvent[] {
    return [...this.pack.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }
}