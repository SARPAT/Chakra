// Event bus — fans each CHAKRA event out to every attached sink. A sink that
// throws is skipped for that event; emit() itself never throws.

import type { ChakraEvent, ChakraEventSink } from '../types';

/** A fan-out sink; `add` returns an idempotent unsubscribe function. */
export interface ChakraEventBus extends ChakraEventSink {
  add(sink: ChakraEventSink): () => void;
}

/**
 * Create a fan-out sink. The sink array is copy-on-write, so `emit` walks it
 * without allocating and changes made during an emit apply from the next event.
 */
export function createEventBus(...sinks: ChakraEventSink[]): ChakraEventBus {
  let list = sinks.filter((s) => typeof s?.emit === 'function');
  return {
    emit(event: ChakraEvent): void {
      const current = list;
      for (let i = 0; i < current.length; i++) {
        try {
          current[i].emit(event);
        } catch {
          /* isolate failing sinks */
        }
      }
    },
    add(sink: ChakraEventSink): () => void {
      if (typeof sink?.emit !== 'function') return () => {};
      list = [...list, sink];
      let attached = true;
      return () => {
        const i = attached ? list.indexOf(sink) : -1;
        attached = false;
        if (i !== -1) list = [...list.slice(0, i), ...list.slice(i + 1)];
      };
    },
  };
}
