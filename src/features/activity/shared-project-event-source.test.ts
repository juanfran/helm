// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { sharedProjectEventSource } from "./shared-project-event-source";

class FakePort extends EventTarget {
  postMessage = vi.fn();
  close = vi.fn();
  start = vi.fn();
}
class FakeWorker extends EventTarget {
  port = new FakePort();
}
class NativeSource extends EventTarget {
  close = vi.fn();
}
afterEach(() => vi.unstubAllGlobals());

it("forwards shared-worker events and releases subscriptions on page exit and cleanup", () => {
  const worker = new FakeWorker();
  vi.stubGlobal(
    "SharedWorker",
    vi.fn(function () {
      return worker;
    }),
  );
  const source = sharedProjectEventSource("/api/events?projectId=one&after=7");
  const listener = vi.fn();
  source.addEventListener("helm", listener);
  worker.port.dispatchEvent(new MessageEvent("message", { data: { type: "helm", data: "event" } }));
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ data: "event" }));
  window.dispatchEvent(new Event("pagehide"));
  expect(worker.port.postMessage).toHaveBeenLastCalledWith(false);
  window.dispatchEvent(new Event("pageshow"));
  expect(worker.port.postMessage).toHaveBeenLastCalledWith("/api/events?projectId=one&after=7");
  source.close();
  expect(worker.port.postMessage).toHaveBeenLastCalledWith(null);
  expect(worker.port.close).toHaveBeenCalledOnce();
  const count = worker.port.postMessage.mock.calls.length;
  window.dispatchEvent(new Event("pageshow"));
  worker.port.dispatchEvent(new MessageEvent("message", { data: { type: "helm", data: "late" } }));
  expect(worker.port.postMessage).toHaveBeenCalledTimes(count);
  expect(listener).toHaveBeenCalledOnce();
});

it("shares a tab-local fallback when workers are unavailable without leaking on repeated resumes", async () => {
  vi.stubGlobal("SharedWorker", undefined);
  const native = new NativeSource();
  const create = vi.fn(function () {
    return native;
  });
  vi.stubGlobal("EventSource", create);
  const first = sharedProjectEventSource("/api/events?after=7");
  const second = sharedProjectEventSource("/api/events?projectId=one&after=7");
  window.dispatchEvent(new Event("pageshow"));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  first.close();
  expect(native.close).not.toHaveBeenCalled();
  second.close();
  expect(native.close).toHaveBeenCalledOnce();
});

it("falls back when the worker script fails, and does not subscribe after cleanup", async () => {
  const worker = new FakeWorker();
  vi.stubGlobal(
    "SharedWorker",
    vi.fn(function () {
      return worker;
    }),
  );
  const native = new NativeSource();
  const create = vi.fn(function () {
    return native;
  });
  vi.stubGlobal("EventSource", create);
  const source = sharedProjectEventSource("/api/events?after=9");
  worker.dispatchEvent(new Event("error"));
  worker.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  source.close();
  expect(native.close).toHaveBeenCalledOnce();
  worker.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(create).toHaveBeenCalledOnce();
});
