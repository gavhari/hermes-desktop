import { describe, expect, it, vi } from "vitest";
import { executeSlash, parseSlash } from "./slashExec";

describe("parseSlash", () => {
  it("splits name and trimmed argument", () => {
    expect(parseSlash("/compress here please")).toEqual({
      name: "compress",
      arg: "here please",
    });
    expect(parseSlash("/compact")).toEqual({ name: "compact", arg: "" });
    expect(parseSlash("/")).toEqual({ name: "", arg: "" });
  });
});

describe("executeSlash", () => {
  it("renders slash.exec output and reports done", async () => {
    const request = vi.fn().mockResolvedValue({ output: "compacted 12 turns" });
    const sys = vi.fn();

    const outcome = await executeSlash({
      command: "/compact",
      sessionId: "sid",
      request,
      sys,
    });

    expect(outcome).toEqual({ kind: "done" });
    // The leading slash is stripped before hitting the worker.
    expect(request).toHaveBeenCalledWith("slash.exec", {
      command: "compact",
      session_id: "sid",
    });
    expect(sys).toHaveBeenCalledWith("compacted 12 turns");
  });

  it("prefixes warnings ahead of the body", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ output: "done", warning: "session rotated" });
    const sys = vi.fn();

    await executeSlash({ command: "/compress", sessionId: "s", request, sys });

    expect(sys).toHaveBeenCalledWith("warning: session rotated\ndone");
  });

  it("falls back to command.dispatch when slash.exec rejects", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "slash.exec") throw new Error("4018 use command.dispatch");
      return { type: "exec", output: "ran quick command" };
    });
    const sys = vi.fn();

    const outcome = await executeSlash({
      command: "/deploy",
      sessionId: "s",
      request,
      sys,
    });

    expect(outcome).toEqual({ kind: "done" });
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      name: "deploy",
      arg: "",
      session_id: "s",
    });
    expect(sys).toHaveBeenCalledWith("ran quick command");
  });

  it("returns a send directive for commands that resolve to an agent prompt", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "slash.exec") throw new Error("not a worker command");
      return { type: "send", message: "search the web for otters" };
    });
    const sys = vi.fn();

    const outcome = await executeSlash({
      command: "/web otters",
      sessionId: "s",
      request,
      sys,
    });

    expect(outcome).toEqual({
      kind: "send",
      message: "search the web for otters",
    });
  });

  it("announces a skill load and forwards its message as a send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "slash.exec") throw new Error("skill command");
      return { type: "skill", name: "pdf", message: "use the pdf skill" };
    });
    const sys = vi.fn();

    const outcome = await executeSlash({
      command: "/pdf report.pdf",
      sessionId: "s",
      request,
      sys,
    });

    expect(sys).toHaveBeenCalledWith("⚡ loading skill: pdf");
    expect(outcome).toEqual({ kind: "send", message: "use the pdf skill" });
  });

  it("follows an alias to its target command", async () => {
    const request = vi.fn(
      async (method: string, params: { command?: string }) => {
        if (method === "slash.exec") {
          if (params.command === "c") throw new Error("unknown");
          return { output: "compacted" }; // resolved target succeeds
        }
        return { type: "alias", target: "compact" };
      },
    );
    const sys = vi.fn();

    const outcome = await executeSlash({
      command: "/c",
      sessionId: "s",
      request,
      sys,
    });

    expect(outcome).toEqual({ kind: "done" });
    expect(sys).toHaveBeenCalledWith("compacted");
  });

  it("reports an error for an empty command", async () => {
    const request = vi.fn();
    const outcome = await executeSlash({
      command: "/",
      sessionId: "s",
      request,
      sys: vi.fn(),
    });
    expect(outcome).toEqual({ kind: "error", message: "empty slash command" });
    expect(request).not.toHaveBeenCalled();
  });
});
