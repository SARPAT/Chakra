// Event bus — fans each CHAKRA event out to every attached sink. A sink that
// throws is skipped for that event; emit() itself never throws.

import type { ChakraEvent, ChakraEventSink } from '../types';

/** Create a fan-out sink over `sinks`; invalid entries are ignored. */
export function createEventBus(...sinks: ChakraEventSink[]): ChakraEventSink {
  const list = sinks.filter((s) => typeof s?.emit === 'function');
  return {
    emit(event: ChakraEvent): void {
      for (let i = 0; i < list.length; i++) {
        try {
          list[i].emit(event);
        } catch {
          /* isolate failing sinks */
        }
      }
    },
  };
}
