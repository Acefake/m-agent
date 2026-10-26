"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * fetchBridge 直连测试：用假的 Node 代理接口验证流式读取、响应头透传与中止语义。
 *
 * 桥接层的输入是 AI SDK 构造的 Request，输出必须是带 SSE 流的 Response；
 * 这里不启动真实网络与插件服务，只验证约定范围内的行为。
 */

/** 把源码转成 CommonJS 并在独立上下文里执行，返回模块导出 */
function loadSource(file, context) {
  const source = fs.readFileSync(require.resolve(file), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { ...context, exports: module.exports, module });
  return module.exports;
}

function loadBridge(proxy) {
  const aiError = loadSource("../src/ai-assistant/ai-error.ts", { console, Error, RegExp, Set });
  const bridge = loadSource("../src/ai-assistant/provider/fetchBridge.ts", {
    console,
    Error,
    TypeError,
    Set,
    DOMException,
    TextEncoder,
    Request,
    Response,
    ReadableStream,
    setTimeout,
    clearTimeout,
    require: name => {
      if (name === "./nodeProxy") return proxy;
      if (name === "./polyfills") return {};
      if (name === "../ai-error") return aiError;
      return require(name);
    }
  });
  return bridge.createAiFetchBridge;
}

test("桥接层按流式分片返回响应，并透传状态与响应头", async () => {
  const calls = [];
  const proxy = {
    beginAiRequest: async payload => {
      calls.push({ kind: "begin", payload });
      return { requestId: payload.requestId, status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } };
    },
    pollAiRequest: async requestId => {
      calls.push({ kind: "poll", requestId });
      const index = calls.filter(call => call.kind === "poll").length;
      if (index === 1) return { chunks: ['data: {"a"}\n\n'], done: false };
      return { chunks: ["data: [DONE]\n\n"], done: true };
    },
    abortAiRequest: async () => {
      calls.push({ kind: "abort" });
    }
  };

  const fetchImpl = loadBridge(proxy)("secret-key");
  const response = await fetchImpl("https://example.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [], stream: true })
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), 'data: {"a"}\n\ndata: [DONE]\n\n');

  const begin = calls.find(call => call.kind === "begin");
  assert.equal(begin.payload.url, "https://example.test/v1/chat/completions");
  assert.equal(begin.payload.method, "POST");
  assert.equal(begin.payload.apiKey, "secret-key");
  assert.match(begin.payload.body, /"stream":true/);
});

test("响应头前 socket hang up 交给真实 AI SDK 重试并恢复输出", async () => {
  const { streamText } = require("ai");
  const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
  const ids = [];
  const aborted = [];
  const proxy = {
    beginAiRequest: async payload => {
      ids.push(payload.requestId);
      if (ids.length === 1) throw new Error("操作失败：Error: socket hang up");
      return { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } };
    },
    pollAiRequest: async () => ({
      chunks: ['data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"恢复成功"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
      done: true
    }),
    abortAiRequest: async id => { aborted.push(id); }
  };
  const provider = createOpenAICompatible({ name: "fixture", baseURL: "https://fixture.invalid/v1", fetch: loadBridge(proxy)() });
  const result = streamText({ model: provider.chatModel("fixture"), prompt: "test", onError: () => undefined });
  assert.equal(await result.text, "恢复成功");
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(aborted, [ids[0]]);
});

test("工具调用之后的下一段请求在响应头前断开，仍会重试并完成本轮", async () => {
  const { streamText, tool, jsonSchema, isStepCount } = require("ai");
  const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
  const head = { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } };
  const frame = (delta, finish) =>
    "data: " +
    JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) +
    "\n\n";
  const toolFrames =
    frame({ role: "assistant", content: "" }, null) +
    frame({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }, null) +
    frame({}, "tool_calls") +
    "data: [DONE]\n\n";
  const finalFrames = frame({ role: "assistant", content: "恢复成功" }, null) + frame({}, "stop") + "data: [DONE]\n\n";
  const ids = [];
  const aborted = [];
  const proxy = {
    beginAiRequest: async payload => {
      ids.push(payload.requestId);
      // 第一次拿到工具调用；工具执行完的下一段请求在响应头前被供应商挂断
      if (ids.length === 2) throw new Error("操作失败：Error: socket hang up");
      return head;
    },
    pollAiRequest: async requestId => ({ chunks: [requestId === ids[0] ? toolFrames : finalFrames], done: true }),
    abortAiRequest: async id => {
      aborted.push(id);
    }
  };
  const provider = createOpenAICompatible({ name: "fixture", baseURL: "https://fixture.invalid/v1", fetch: loadBridge(proxy)() });
  const result = streamText({
    model: provider.chatModel("fixture"),
    prompt: "test",
    tools: { read: tool({ inputSchema: jsonSchema({ type: "object", additionalProperties: true }), execute: async () => "ok" }) },
    stopWhen: isStepCount(4),
    onError: () => undefined
  });
  assert.equal(await result.text, "恢复成功");
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(aborted, [ids[1]]);
});

test("非网络失败保持原异常，不标记为可重试", async () => {
  const failure = new Error("无效 AI 请求");
  const fetchImpl = loadBridge({ beginAiRequest: async () => { throw failure; }, abortAiRequest: async () => undefined })();
  await assert.rejects(fetchImpl("https://example.test/v1/chat/completions", { method: "POST", body: "{}" }), error => error === failure && !error.code);
});

test("GET 请求不带请求体，供模型列表接口使用", async () => {
  const proxy = {
    beginAiRequest: async payload => {
      assert.equal(payload.method, "GET");
      assert.equal(payload.body, "");
      return { requestId: payload.requestId, status: 200, statusText: "OK", headers: { "content-type": "application/json" } };
    },
    pollAiRequest: async () => ({ chunks: ['{"data":[{"id":"m1"}]}'], done: true }),
    abortAiRequest: async () => undefined
  };

  const fetchImpl = loadBridge(proxy)("");
  const response = await fetchImpl("https://example.test/v1/models");
  assert.deepEqual(await response.json(), { data: [{ id: "m1" }] });
});

test("请求中止时抛出 AbortError 并通知代理中止请求", async () => {
  const aborted = [];
  const proxy = {
    beginAiRequest: async payload => ({ requestId: payload.requestId, status: 200, statusText: "OK", headers: {} }),
    // 模拟 Node 的长轮询：正常返回要等一段时间，中止时不能让读取线程一直挂着
    pollAiRequest: () => new Promise(resolve => setTimeout(() => resolve({ chunks: [], done: false }), 50)),
    abortAiRequest: async requestId => {
      aborted.push(requestId);
    }
  };

  const fetchImpl = loadBridge(proxy)();
  const controller = new AbortController();
  const response = await fetchImpl("https://example.test/v1/chat/completions", { method: "POST", body: "{}", signal: controller.signal });

  const reading = response.text();
  controller.abort();
  await assert.rejects(reading, error => error.name === "AbortError");
  // 中止可能同时由信号监听与读取循环各触发一次，代理侧是幂等的；这里只要求确实通知过且指向同一请求
  assert.ok(aborted.length >= 1);
  assert.equal(new Set(aborted).size, 1);
});

test("分片中带回错误时流以错误结束", async () => {
  const proxy = {
    beginAiRequest: async payload => ({ requestId: payload.requestId, status: 502, statusText: "Bad Gateway", headers: {} }),
    pollAiRequest: async () => ({ chunks: [], done: true, error: "供应商连接中断" }),
    abortAiRequest: async () => undefined
  };

  const fetchImpl = loadBridge(proxy)();
  const response = await fetchImpl("https://example.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 502);
  await assert.rejects(response.text(), /供应商连接中断/);
});
