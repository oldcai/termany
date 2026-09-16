import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultAgentRuntime } from "@termany/core";
import { checkNativeAcpSupport } from "./nativeAcp.js";

test("native ACP probes reject old or broken installations without starting a conversation", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-native-help-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "fixture");
  const agent = (id: string) => ({ id, name: id, command: id, args: "", enabled: true, builtIn: true, runtime: defaultAgentRuntime(id) });
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "--help" ] || exit 23\nprintf "Usage: kilo [prompt]\\n  --auto\\n"\n', { mode: 0o755 });
  await assert.rejects(checkNativeAcpSupport(agent("kilocode"), command, process.env), /does not support ACP/);
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "--help" ] || exit 23\nprintf "Commands:\\n  kilo acp  Start ACP server\\n"\n', { mode: 0o755 });
  await checkNativeAcpSupport(agent("kilocode"), command, process.env);
  // A CLI that colorizes its help (FORCE_COLOR in the launching shell) still
  // reads as supported: the escape sequence must not swallow the word boundary.
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "--help" ] || exit 23\nprintf "Commands:\\n  \\033[38;5;209macp *\\033[39m  Start ACP server\\n"\n', { mode: 0o755 });
  await checkNativeAcpSupport(agent("kilocode"), command, process.env);
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "--help" ] || exit 23\nprintf "Options: --acp\\n"\n', { mode: 0o755 });
  await checkNativeAcpSupport(agent("gemini"), command, process.env);
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "acp" ] && [ "$2" = "--help" ] || exit 23\nprintf "Usage: agent acp [options]\\n"\n', { mode: 0o755 });
  await checkNativeAcpSupport(agent("cursor"), command, process.env);
  await checkNativeAcpSupport(agent("kimi"), command, process.env);
  await fs.writeFile(command, '#!/bin/sh\n[ "$1" = "agent" ] && [ "$2" = "stdio" ] && [ "$3" = "--help" ] || exit 23\nprintf "Usage: grok agent stdio [OPTIONS]\\n"\n', { mode: 0o755 });
  await checkNativeAcpSupport(agent("grok"), command, process.env);
  await fs.writeFile(command, '#!/missing/termany/python\n', { mode: 0o755 });
  await assert.rejects(checkNativeAcpSupport(agent("kimi"), command, process.env), /Check or reinstall/);
  await checkNativeAcpSupport({ ...agent("kimi"), runtime: { ...defaultAgentRuntime("kimi")!, distribution: "custom" } }, command, process.env);
});
