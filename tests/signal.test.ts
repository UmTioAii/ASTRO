import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installCancellation } from "../src/signal";

test("SIGINT aborta o sinal do run; o segundo sinal força a saída", () => {
  const emitter = new EventEmitter();
  let forced = 0;
  const { signal, dispose } = installCancellation({ target: emitter, onForce: () => { forced++; } });

  emitter.emit("SIGINT");
  expect(signal.aborted).toBe(true);
  expect(forced).toBe(0);

  emitter.emit("SIGINT");
  expect(forced).toBe(1);

  dispose();
  expect(emitter.listenerCount("SIGINT")).toBe(0);
  expect(emitter.listenerCount("SIGTERM")).toBe(0);
});

test("SIGTERM também cancela", () => {
  const emitter = new EventEmitter();
  const { signal, dispose } = installCancellation({ target: emitter, onForce: () => {} });
  emitter.emit("SIGTERM");
  expect(signal.aborted).toBe(true);
  dispose();
});
