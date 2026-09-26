/** One event from the engine's stream: its name, and a payload shaped like the view row. */
export interface EngineEvent {
  event: string;
  data: unknown;
}

export interface EngineListener {
  event(event: EngineEvent): void;
  /**
   * Anything may have changed unseen: the stream (re)opened, an event
   * could not be read, or the stream is gone for now.
   */
  resync(reason: string): void;
}

/** The engine's event stream, as the engine and the stand-in both offer it. */
export interface EngineEvents {
  /** Starts listening; the returned function stops. */
  listen(listener: EngineListener): () => void;
}
