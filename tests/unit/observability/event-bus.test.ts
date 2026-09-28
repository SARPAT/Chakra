// Tests for the observability event bus: fan-out, isolation of failing sinks,
// add/unsubscribe and mutation during emit.

import { describe, it, expect, vi } from 'vitest';
import { createEventBus } from '../../../src/observability/event-bus';
import type { ChakraEvent, ChakraEventSink } from '../../../src/types';

const LAG: ChakraEvent = { type: 'event_loop_lag', lagMs: 3 };

function recorder(): ChakraEventSink & { events: ChakraEvent[] } {
  const events: ChakraEvent[] = [];
  return { events, emit: (e) => { events.push(e); } };
}

describe('createEventBus', () => {
  it('forwards each event to every initial sink in order', () => {
    const order: string[] = [];
    const a = { emit: vi.fn(() => { order.push('a'); }) };
    const b = { emit: vi.fn(() => { order.push('b'); }) };
    const bus = createEventBus(a, b);

    bus.emit(LAG);

    expect(a.emit).toHaveBeenCalledWith(LAG);
    expect(b.emit).toHaveBeenCalledWith(LAG);
    expect(order).toEqual(['a', 'b']);
  });

  it('works with no sinks', () => {
    expect(() => createEventBus().emit(LAG)).not.toThrow();
  });

  it('isolates a throwing sink: others still receive the event and emit does not throw', () => {
    const before = recorder();
    const after = recorder();
    const bad = { emit: () => { throw new Error('boom'); } };
    const bus = createEventBus(before, bad, after);

    expect(() => bus.emit(LAG)).not.toThrow();
    expect(() => bus.emit(LAG)).not.toThrow();
    expect(before.events).toHaveLength(2);
    expect(after.events).toHaveLength(2);
  });

  it('isolates sinks that throw non-Error values', () => {
    const good = recorder();
    const bus = createEventBus({ emit: () => { throw 'string'; } }, good);
    expect(() => bus.emit(LAG)).not.toThrow();
    expect(good.events).toEqual([LAG]);
  });

  it('keeps the sink as `this` when calling emit', () => {
    const sink = {
      seen: 0,
      emit(this: { seen: number }) { this.seen++; },
    };
    createEventBus(sink).emit(LAG);
    expect(sink.seen).toBe(1);
  });

  it('add() attaches a sink and the returned function detaches it', () => {
    const bus = createEventBus();
    const sink = recorder();

    const off = bus.add(sink);
    bus.emit(LAG);
    off();
    bus.emit(LAG);

    expect(sink.events).toHaveLength(1);
  });

  it('unsubscribe is idempotent and only removes its own registration', () => {
    const bus = createEventBus();
    const sink = recorder();
    const other = recorder();

    const off1 = bus.add(sink);
    bus.add(sink);
    bus.add(other);
    off1();
    off1();
    bus.emit(LAG);

    expect(sink.events).toHaveLength(1);
    expect(other.events).toHaveLength(1);
  });

  it('unsubscribing an added sink leaves constructor sinks attached', () => {
    const initial = recorder();
    const bus = createEventBus(initial);
    const off = bus.add(recorder());
    off();
    bus.emit(LAG);
    expect(initial.events).toHaveLength(1);
  });

  it('ignores invalid sinks', () => {
    const good = recorder();
    const bus = createEventBus(
      undefined as unknown as ChakraEventSink,
      {} as ChakraEventSink,
      good,
    );
    const off = bus.add(null as unknown as ChakraEventSink);
    expect(() => off()).not.toThrow();
    expect(() => bus.emit(LAG)).not.toThrow();
    expect(good.events).toHaveLength(1);
  });

  it('changes made during emit take effect from the next event', () => {
    const bus = createEventBus();
    const late = recorder();
    let offSelf: () => void = () => {};
    const selfRemoving = {
      calls: 0,
      emit() {
        this.calls++;
        offSelf();
        bus.add(late);
      },
    };
    offSelf = bus.add(selfRemoving);

    bus.emit(LAG);
    expect(selfRemoving.calls).toBe(1);
    expect(late.events).toHaveLength(0);

    bus.emit(LAG);
    expect(selfRemoving.calls).toBe(1);
    expect(late.events).toHaveLength(1);
  });

  it('can be nested as a sink of another bus', () => {
    const leaf = recorder();
    const inner = createEventBus(leaf);
    const outer = createEventBus(inner);
    outer.emit(LAG);
    expect(leaf.events).toEqual([LAG]);
  });
});
