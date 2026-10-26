"use strict";
require("reflect-metadata");
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const writes = [];
let allowed = [{ metaclass: "Package", appliedStereotypes: [] }];
let failCreate = false;
let children = [];
const validators = new Proxy({}, { get: () => () => () => undefined });
const method = verb => route => (target, name) => {
  Reflect.defineMetadata("path", route, target[name]);
  Reflect.defineMetadata("method", verb, target[name]);
};
const param = type => () => (target, name, index) => {
  const args = Reflect.getMetadata("__routeArguments__", target.constructor, name) || {};
  args[type + ":" + index] = { index };
  Reflect.defineMetadata("__routeArguments__", args, target.constructor, name);
};

global.__M_DESIGN_NODE_API__ = {
  NestjsCommon: require("@nestjs/common"),
  ClassValidator: require("class-validator"),
  DesignNodeApi: {
    ResData: class {
      constructor(data) {
        this.code = 1000;
        this.data = data;
      }
    },
    transaction: async (options, action) => {
      writes.push({ transaction: options });
      return action({
        nodeService: {
          getNode: async id => (id === "missing" ? undefined : { id, from: 3 }),
          getCanCreateChildTypes: async () => allowed,
          getNodeChildren: async () => children
        },
        modelService: {
          createModel: async dto => {
            if (failCreate) throw new Error("Java 创建失败");
            writes.push(dto);
            return {
              createdInstance: {
                id: "actual-main-id",
                name: dto.customName,
                metaclass: dto.metaclass
              },
              createdModels: [{ id: "auxiliary-id" }, { id: "actual-main-id" }]
            };
          }
        },
        step: {}
      });
    }
  }
};
const plugin = require("../dist/main.js");
const Controller = plugin.controllers[0];
const controller = new Controller();
const user = id => ({ headers: { userid: id } });
const create = overrides => ({
  projectId: "p",
  parentId: "root",
  name: "系统",
  metaclass: "Package",
  stereotypes: [],
  hasSysMLPermission: "true",
  ...overrides
});

test("路由名称唯一，保留 DTO 和请求参数元数据", () => {
  assert.equal(Reflect.getMetadata("path", Controller), "assistant");
  const paths = ["begin", "poll", "abort", "createNode"].map(name => Reflect.getMetadata("path", Controller.prototype[name]));
  assert.equal(new Set(paths).size, 4);
  assert.equal(Reflect.getMetadata("design:paramtypes", Controller.prototype, "createNode")[0].name, "CreateNodeDto");
  assert.equal(Reflect.getMetadata("__routeArguments__", Controller, "begin")["0:1"].index, 1);
});

test("标准创建在项目事务内执行，返回主节点而非附带模型", async () => {
  writes.length = 0;
  const result = await controller.createNode(create());
  assert.equal(result.data.id, "actual-main-id");
  assert.deepEqual(writes[0], { transaction: { projectId: "p" } });
  assert.equal(writes[1].customName, "系统");
  assert.equal(writes[1].type, 0);
  assert.equal(writes[1].isAutoOpenDiagram, false);
});

test("查询结果之外的类型和错误构造型不得写入", async () => {
  writes.length = 0;
  await assert.rejects(controller.createNode(create({ metaclass: "Class", stereotypes: ["invented"] })), /不允许/);
  assert.equal(writes.filter(item => item.customName).length, 0);
});

test("缺失父节点、重复名称及图表不会写入", async () => {
  await assert.rejects(controller.createNode(create({ parentId: "missing" })), /不存在/);
  children = [{ name: "系统" }];
  await assert.rejects(controller.createNode(create()), /同名/);
  children = [];
  allowed = [{ metaclass: "Diagram", appliedStereotypes: [] }];
  await assert.rejects(controller.createNode(create({ metaclass: "Diagram" })), /图表或关系/);
  allowed = [{ metaclass: "Package", appliedStereotypes: [] }];
});

test("Java 错误继续抛出给宿主事务，不伪造成功", async () => {
  failCreate = true;
  await assert.rejects(controller.createNode(create()), /Java 创建失败/);
  failCreate = false;
});

test("SSE 字符完整、用户隔离、响应头和轮询结束", async () => {
  let authorization;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"text":"车辆"}\n\n');
    setTimeout(() => response.end("data: [DONE]\n\n"), 15);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const id = "stream-test";
    const result = await controller.begin(
      {
        requestId: id,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        body: JSON.stringify({ model: "test", messages: [], stream: true })
      },
      { headers: { userid: "a", "x-agent-api-key": "test-key" } }
    );
    assert.equal(result.data.status, 200);
    await assert.rejects(controller.poll({ requestId: id }, user("b")), /不存在/);
    let text = "";
    let done = false;
    while (!done) {
      const { data } = await controller.poll({ requestId: id }, user("a"));
      text += data.chunks.join("");
      done = data.done;
    }
    assert.match(text, /车辆/);
    assert.match(text, /\[DONE\]/);
    assert.equal(authorization, "Bearer test-key");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("请求标识允许 nanoid 的 URL 安全字符（下划线）", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    // 线上失败样本：渲染层用 nanoid，标识里会带下划线
    const id = "N1B7hNKe_GczWJwzv-1";
    const result = await controller.begin(
      {
        requestId: id,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        body: JSON.stringify({ model: "test", messages: [], stream: true })
      },
      user("a")
    );
    assert.equal(result.data.status, 200);
    // 中止同样走标识校验，一并覆盖
    await controller.abort({ requestId: id }, user("a"));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("停止请求和停用插件释放流", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: working\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await controller.begin(
      {
        requestId: "cancel",
        url: `http://127.0.0.1:${server.address().port}/chat/completions`,
        body: JSON.stringify({ model: "test", messages: [], stream: true })
      },
      user("a")
    );
    assert.equal((await controller.abort({ requestId: "cancel" }, user("a"))).data, true);
    await assert.rejects(controller.poll({ requestId: "cancel" }, user("a")), /不存在/);
    await plugin.onInstall();
    await plugin.onUninstall();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("额外请求头原样转发，保留头不允许被覆盖", async () => {
  let received;
  const server = http.createServer((request, response) => {
    received = request.headers;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const id = "extra-headers-test";
    await controller.begin(
      {
        requestId: id,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        body: JSON.stringify({ model: "test", messages: [], stream: true }),
        method: "POST",
        extraHeaders: {
          "x-opencode-session": "session-abc",
          "x-custom-tag": "tag-1",
          // 以下都必须被剔除
          Authorization: "Bearer stolen",
          Host: "evil.example.com",
          "content-length": "5",
          "bad name": "spaces",
          "x-inject": "line\r\nbreak"
        }
      },
      { headers: { userid: "a", "x-agent-api-key": "real-key" } }
    );

    assert.equal(received["x-opencode-session"], "session-abc");
    assert.equal(received["x-custom-tag"], "tag-1");
    assert.equal(received.authorization, "Bearer real-key");
    assert.notEqual(received.host, "evil.example.com");
    assert.equal(received["bad name"], undefined);
    assert.equal(received["x-inject"], undefined);
    await controller.abort({ requestId: id }, user("a"));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("代理不接受含凭据或非兼容接口的地址", () => {
  assert.throws(
    () =>
      controller.begin(
        {
          requestId: "bad-url",
          url: "http://key:secret@localhost/chat/completions",
          body: "{}"
        },
        user("a")
      ),
    /仅支持/
  );
});

test("GET 只允许模型列表接口，且不带请求体", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const id = "models-test";
    const result = await controller.begin(
      {
        requestId: id,
        url: `http://127.0.0.1:${server.address().port}/v1/models`,
        body: "",
        method: "GET"
      },
      user("a")
    );
    assert.equal(result.data.status, 200);

    let text = "";
    let done = false;
    while (!done) {
      const { data } = await controller.poll({ requestId: id }, user("a"));
      text += data.chunks.join("");
      done = data.done;
    }
    assert.match(text, /test-model/);

    assert.throws(
      () =>
        controller.begin(
          {
            requestId: "bad-get",
            url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
            body: "",
            method: "GET"
          },
          user("a")
        ),
      /\/models/
    );
    assert.throws(
      () =>
        controller.begin(
          {
            requestId: "get-body",
            url: `http://127.0.0.1:${server.address().port}/v1/models`,
            body: "{}",
            method: "GET"
          },
          user("a")
        ),
      /请求体/
    );
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
