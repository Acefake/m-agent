import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { getAiAssistantHost, tryGetAiAssistantHost } from "../host";
import { normalizeOperations } from "../changes/proposal";
import type { AiPermissionMode } from "../types";

/** 一步变更计划：一个可执行操作 + 验收说明 */
interface PlanStepArgs extends ChangeOperationArgs {
  /** 完成这步后的验收标准 / 预期结果 */
  acceptance?: string;
  /** 相关说明 */
  doc?: string;
}

interface PresentPlanArgs {
  title: string;
  summary: string;
  steps: PlanStepArgs[];
}

interface ChangeProposalArgs {
  title: string;
  summary: string;
  operations: ChangeOperationArgs[];
}

/** 一项变更操作；提案与直接执行共用同一套字段 */
interface ChangeOperationArgs {
  id?: string;
  type:
    | "create-element"
    | "update-property"
    | "delete-element"
    | "replace-sysml-text"
    | "create-shape"
    | "create-connector"
    | "place-shape"
    | "arrange-shapes";
  summary: string;
  name?: string;
  elementType?: string;
  containerId?: string;
  elementId?: string;
  propertyName?: string;
  propertyKey?: string;
  oldValue?: string;
  newValue?: string;
  control?: string;
  namespaceId?: string;
  textualContent?: string;
  diagramId?: string;
  elementConfigId?: string;
  containerShapeId?: string;
  x?: string;
  y?: string;
  sourceShapeId?: string;
  targetShapeId?: string;
  shapeIds?: string;
  layout?: string;
  direction?: string;
  ref?: string;
  startX?: string;
  startY?: string;
}

interface ApplyChangesArgs {
  title: string;
  operations: ChangeOperationArgs[];
}

interface ModelTreeArgs {
  rootId?: string;
  maxDepth?: number;
  maxNodes?: number;
}

interface SearchArgs {
  keyword: string;
}

interface ElementArgs {
  elementId: string;
}

interface PropertyArgs extends ElementArgs {
  propertyNames?: string[];
}

interface ElementChildrenArgs {
  elementId: string;
  depth?: number;
}

interface OptionalElementArgs {
  elementId?: string;
}

interface CreatableElementTypesArgs {
  containerId: string;
}

interface AskUserChoiceArgs {
  question: string;
  options: Array<{
    id?: string;
    label: string;
    description?: string;
  }>;
  allowCustomInput?: boolean;
}

interface DiagramArgs {
  diagramId?: string;
}

interface DiagramShapesArgs {
  diagramId?: string;
  maxNodes?: number;
}

/** 单次直接执行（编辑模式）允许的操作条数上限，避免一轮改动过大 */
const MAX_DIRECT_OPERATIONS = 12;

/**
 * 引用与关系布局的公共说明。
 *
 * 提案、分步计划与编辑模式直接执行三个工具共用同一份口径，
 * 与 proposal.ts 的引用预检、host-adapter.ts 的执行解析保持一致。
 */
const REFERENCE_AND_LAYOUT_RULES =
  "本批引用：前序操作声明唯一 ref（字母开头，最多32字符），后续 ID 写 @ref:名称；containerId/elementId 取模型ID，sourceShapeId/targetShapeId/containerShapeId/shapeIds 取图形ID，禁止前向/自引用，不可用名称代替ID。arrange-shapes: layout=auto 使用宿主关系布局，direction=DOWN/UP/RIGHT；也支持 row/column/grid。shapeIds 为逗号分隔的图形ID（可含引用），省略时仅整理本批新建图形。";

/**
 * 变更操作的 JSON Schema：提案与直接执行共用，保证两个工具收参一致。
 *
 * 显式标注为 JSONSchema7（而非 as const）：jsonSchema 的入参要求可变数组，
 * 只读元组会在三个使用处触发 TS2322。
 *
 * 宿主不支持 SysML 文本建模（features.sysmlText === false）时，枚举里不再出现
 * replace-sysml-text：这类宿主上该操作必然被拒绝，暴露给模型只会浪费一轮工具调用。
 */
function buildOperationSchema(): JSONSchema7 {
  const textEnabled = tryGetAiAssistantHost()?.features?.sysmlText !== false;
  const types = ["create-element", "update-property", "delete-element"];
  if (textEnabled) types.push("replace-sysml-text");
  types.push("create-shape", "create-connector", "place-shape", "arrange-shapes");

  return {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: types },
      summary: { type: "string" },
      name: { type: "string" },
      elementType: { type: "string" },
      containerId: { type: "string" },
      elementId: { type: "string" },
      propertyName: { type: "string" },
      propertyKey: { type: "string" },
      oldValue: {
        type: "string",
        description: "属性当前值：逐字取自 model_get_properties 的返回；当前值为空时传空字符串（空值是合法取值，省略字段才会被判为缺参数）"
      },
      newValue: { type: "string" },
      control: { type: "string" },
      namespaceId: { type: "string" },
      textualContent: { type: "string" },
      diagramId: { type: "string" },
      elementConfigId: { type: "string" },
      containerShapeId: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      sourceShapeId: { type: "string" },
      targetShapeId: { type: "string" },
      shapeIds: { type: "string" },
      layout: { type: "string" },
      direction: {
        type: "string",
        description: "arrange-shapes layout=auto 时的布局方向：DOWN（默认，从上到下）/ UP / RIGHT"
      },
      ref: {
        type: "string",
        description:
          "本地引用名（提案内唯一的英文短名，字母开头）：后续操作的 id 字段可用 @ref:名称 引用本操作创建的对象。仅用于同一提案内引用刚创建的对象，不能代替真实 id 查询"
      },
      startX: { type: "string" },
      startY: { type: "string" }
    },
    required: ["type", "summary"],
    additionalProperties: false
  };
}

/**
 * 生成待确认提案的工具：只有提案模式才暴露给模型。
 *
 * 不放进 readOnlyTools——那份工具集会被聊天（只读）模式原样返回，模型就能生成一张
 * 带「确认并执行」的卡片：它在只读模式下本就不该出现，卡片一旦随会话持久化，
 * 用户切回提案模式点它还会直接落盘一条没人确认过的改动。
 * 单独成函数也让 agent.ts 的补救轮（模型只在正文里描述方案时强制补一次工具调用）
 * 复用同一份定义，不必再从工具集里挑。
 */
export function createProposeChangesTool() {
  return tool({
    description:
      "生成一份等待用户确认的结构化模型变更提案。只用于新增/修改/删除模型元素或画布图形操作，调用本工具不会修改模型。每项必须是参数齐备、可直接执行的模型变更，不能把查询步骤或“待用户确认的事项”写成操作；每项必须给出可理解的 summary。新增单个元素使用 create-element，创建前必须调用 model_get_creatable_element_types，elementType 必须逐字使用其返回值；批量创建用多条 create-element（同一容器批量创建同名元素时 name 用连续编号）。修改属性前必须调用 model_get_properties，propertyKey 与 oldValue 逐字取自返回值。创建需 name、elementType、containerId；属性修改需 elementId、propertyName、propertyKey、oldValue、newValue；删除需 elementId。画布操作：在目标图表创建单个图形用 create-shape（需先调 diagram_read_palette 取 elementConfigId、先调 diagram_list 确认 diagramId；name 为图形名称，x/y 缺省自动找空闲位置）；连接两个已有图形用 create-connector（sourceShapeId/targetShapeId 必须取自 diagram_read_shapes 返回的图形 id）；把已存在的模型元素摆到画布用 place-shape（elementId 为模型元素 id）；批量排布多个图形用 arrange-shapes（layout 可选 auto/row/column/grid，缺省 grid；shapeIds 缺省整理本提案刚创建的图形）。" +
      REFERENCE_AND_LAYOUT_RULES,
    inputSchema: jsonSchema<ChangeProposalArgs>({
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        operations: { type: "array", minItems: 1, items: buildOperationSchema() }
      },
      required: ["title", "summary", "operations"],
      additionalProperties: false
    }),
    execute: async ({ title, operations }: ChangeProposalArgs) => `已生成「${title}」变更提案，共 ${operations.length} 项，等待用户确认。`
  });
}

/**
 * 分步变更计划工具：用户在界面上看分步计划并勾选要执行的步骤，面板据此生成提案。
 *
 * 与 createProposeChangesTool 并列，只挂提案模式：编辑模式直接执行、不出计划卡片。
 * 单独成函数让 agent.ts 的兜底轮（模型只描述方案时强制补一次工具调用）复用同一份定义。
 */
export function createPresentPlanTool() {
  return tool({
    description:
      "把一次较大的模型变更拆成有序分步计划呈现给用户。适用场景：改动超过 3 项、需要先读后改、或你想让用户在动手前先看一遍再决定执行哪些步骤。本工具不会修改模型；用户在界面上勾选若干步骤后，系统据此生成一份待确认提案。每一步就是一个可执行操作（字段与 model_propose_changes 的 operations 一致：创建元素需 name、elementType、containerId；改属性需 elementId、propertyName、propertyKey、oldValue、newValue，其中 propertyKey/oldValue 必须取自 model_get_properties；删除需 elementId；画布操作按 create-shape / create-connector / place-shape / arrange-shapes 的说明填写），另加一句 acceptance 作为这一步的验收标准（执行后用户据以判断做对了没有）。步骤按依赖顺序给出，先读取上下文再执行写入。" +
      REFERENCE_AND_LAYOUT_RULES,
    inputSchema: jsonSchema<PresentPlanArgs>({
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: (() => {
            const schema = buildOperationSchema();
            return { ...schema, properties: { ...schema.properties, acceptance: { type: "string" }, doc: { type: "string" } } };
          })()
        }
      },
      required: ["title", "summary", "steps"],
      additionalProperties: false
    }),
    execute: async ({ title, steps }: PresentPlanArgs) => `已生成「${title}」变更计划，共 ${steps.length} 步，等待用户确认。`
  });
}

/**
 * 创建供 AI 使用的建模工具集合。
 *
 * 暴露哪些工具由权限模式决定：
 * - chat：只给读取类工具，模型物理上无法改模型，也生成不了待确认提案
 * - proposal：读取 + model_propose_changes（生成待确认提案）
 * - edit：读取 + model_apply_changes（直接执行，改动即时落盘，不再出确认卡片）
 *
 * 工具的模型访问能力由宿主应用注入（见 AiModelHost 与 AiEditExecutor），本包不直接依赖宿主内部实现。
 * execute 参数显式标注类型，避免在 noImplicitAny=false 的消费方工程中泛型推断退化。
 *
 * @param permissionMode 当前权限模式，缺省按提案模式
 */
export function createAiTools(permissionMode: AiPermissionMode = "proposal", expertReadOnly = false) {
  const { model, diagram, features } = getAiAssistantHost();
  const noDiagramHost = "当前宿主未提供图表读取能力";
  /** 宿主不支持 SysML 文本建模时，文本类工具整体不下发（模型物理上无法调用） */
  const textToolsEnabled = features?.sysmlText !== false;
  const textTools: ToolSet = textToolsEnabled
    ? {
        text_read_sysml: tool({
          description:
            "读取元素的 SysML v2 文本表示。优先读取已打开的文本标签页；也可传 elementId 按命名空间拉取。元素没有文本文件时（例如项目根命名空间）返回空文本与替代方案，此时不要对它提交 replace-sysml-text。",
          inputSchema: jsonSchema<OptionalElementArgs>({
            type: "object",
            properties: {
              elementId: { type: "string", description: "元素 id 或命名空间 id；缺省读取当前激活的文本标签页" }
            },
            additionalProperties: false
          }),
          execute: async ({ elementId }: OptionalElementArgs) => model.readSysmlText(elementId)
        }),

        text_validate: tool({
          description: "校验已打开文本标签页的 SysML 语法，返回错误/警告列表。",
          inputSchema: jsonSchema<OptionalElementArgs>({
            type: "object",
            properties: {
              elementId: { type: "string", description: "文本标签页的命名空间 id；缺省校验当前激活标签页" }
            },
            additionalProperties: false
          }),
          execute: async ({ elementId }: OptionalElementArgs) => model.validateSysmlText(elementId)
        })
      }
    : {};

  const readOnlyTools = {
    model_get_tree: tool({
      description:
        "获取当前项目的模型树（缩进文本，含元素名称、类型与 id）。仅包含已加载的节点，未加载的子树会标注「子节点未加载」；需要深入时改用 model_get_children。",
      inputSchema: jsonSchema<ModelTreeArgs>({
        type: "object",
        properties: {
          rootId: { type: "string", description: "子树根元素 id，缺省为项目根节点" },
          maxDepth: { type: "integer", minimum: 1, maximum: 8, description: "最大深度，默认 3" },
          maxNodes: { type: "integer", minimum: 10, maximum: 1000, description: "最大节点数，默认 300" }
        },
        additionalProperties: false
      }),
      execute: async ({ rootId, maxDepth, maxNodes }: ModelTreeArgs) => model.getModelTree({ rootId, maxDepth, maxNodes })
    }),

    model_search: tool({
      description: "按关键字搜索模型元素（含标准库），返回匹配元素的名称、类型与 id。",
      inputSchema: jsonSchema<SearchArgs>({
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键字（元素名称片段）" }
        },
        required: ["keyword"],
        additionalProperties: false
      }),
      execute: async ({ keyword }: SearchArgs) => model.searchElements(keyword)
    }),

    model_get_element: tool({
      description: "获取单个元素的概要：名称、类型、id、ownerId、父元素与子元素列表。元素未加载时会自动展开其祖先路径。",
      inputSchema: jsonSchema<ElementArgs>({
        type: "object",
        properties: {
          elementId: { type: "string", description: "元素 id" }
        },
        required: ["elementId"],
        additionalProperties: false
      }),
      execute: async ({ elementId }: ElementArgs) => model.getElement(elementId)
    }),

    model_get_children: tool({
      description:
        "获取指定元素的子元素，会按需自动加载（无需界面上先展开）；depth 可展开多层（默认 1，最大 8），深层展开受加载次数上限约束。",
      inputSchema: jsonSchema<ElementChildrenArgs>({
        type: "object",
        properties: {
          elementId: { type: "string", description: "父元素 id" },
          depth: { type: "integer", minimum: 1, maximum: 8, description: "展开层数，默认 1" }
        },
        required: ["elementId"],
        additionalProperties: false
      }),
      execute: async ({ elementId, depth }: ElementChildrenArgs) => model.getElementChildren(elementId, depth)
    }),

    model_get_relationships: tool({
      description: "获取指定元素的关系（包含关系、引用等），返回关系名称、类型、sourceId 与 targetId；元素未加载时会自动加载。",
      inputSchema: jsonSchema<ElementArgs>({
        type: "object",
        properties: {
          elementId: { type: "string", description: "元素 id" }
        },
        required: ["elementId"],
        additionalProperties: false
      }),
      execute: async ({ elementId }: ElementArgs) => model.getElementRelationships(elementId)
    }),

    model_get_properties: tool({
      description:
        "按需读取元素属性，每行给出 key、名称、当前值、类型与是否只读。已知目标属性时必须用 propertyNames 指定名称或 key，避免反复读取全部属性；仅探索未知属性时省略。生成 update-property 前必须读取当前 propertyKey 与 oldValue，不使用旧摘要里的值。",
      inputSchema: jsonSchema<PropertyArgs>({
        type: "object",
        properties: {
          elementId: { type: "string", description: "元素 id" },
          propertyNames: {
            type: "array",
            items: { type: "string" },
            description: "目标属性名称或 propertyKey，精确匹配；省略时返回全部属性"
          }
        },
        required: ["elementId"],
        additionalProperties: false
      }),
      execute: async ({ elementId, propertyNames }: PropertyArgs) => model.getProperties(elementId, propertyNames)
    }),

    model_get_creatable_element_types: tool({
      description:
        "查询指定容器允许创建的普通元素和图表类型（图表名称带 [图表] 标记），每项返回 elementType 与中文名 name。创建元素或 BDD 等图表都使用 create-element，elementType 必须逐字复制返回值。图表创建后会请求宿主打开，再用 diagram_list 确认 diagramId 后操作画布。",
      inputSchema: jsonSchema<CreatableElementTypesArgs>({
        type: "object",
        properties: {
          containerId: { type: "string", description: "目标容器元素 id" }
        },
        required: ["containerId"],
        additionalProperties: false
      }),
      execute: async ({ containerId }: CreatableElementTypesArgs) =>
        (await model.getCreatableElementTypes(containerId)).map(item => ({ elementType: item.id, name: item.label }))
    }),

    ...textTools,

    diagram_list: tool({
      description: "列出当前项目已打开的图表（名称、id、是否已加载图形、是否为当前可见图表）。读取图形树或组件清单前先用它确认 diagramId。",
      inputSchema: jsonSchema<DiagramArgs>({
        type: "object",
        properties: {},
        additionalProperties: false
      }),
      execute: async () => (diagram ? diagram.listDiagrams() : noDiagramHost)
    }),

    diagram_read_shapes: tool({
      description:
        "读取指定图表当前的图形树：每行给出图形名称、elementConfigId、图形 id、绑定的模型元素 id 与位置；连线额外给出两端图形 id。diagramId 缺省读取当前可见图表。连线等图形操作必须使用这里返回的图形 id，不要自己编造。",
      inputSchema: jsonSchema<DiagramShapesArgs>({
        type: "object",
        properties: {
          diagramId: { type: "string", description: "图表 id，缺省为当前可见图表" },
          maxNodes: { type: "integer", minimum: 10, maximum: 1000, description: "最多返回的图形数量，默认 300" }
        },
        additionalProperties: false
      }),
      execute: async ({ diagramId, maxNodes }: DiagramShapesArgs) => (diagram ? diagram.readShapes(diagramId, maxNodes) : noDiagramHost)
    }),

    diagram_read_palette: tool({
      description:
        "查询指定图表允许创建的图形组件清单，每项返回 elementConfigId 与中文名。要描述或提案画布图形时必须先调用；elementConfigId 必须逐字使用返回值，不能写中文名或自行编造。",
      inputSchema: jsonSchema<DiagramArgs>({
        type: "object",
        properties: {
          diagramId: { type: "string", description: "图表 id，缺省为当前可见图表" }
        },
        additionalProperties: false
      }),
      execute: async ({ diagramId }: DiagramArgs) => (diagram ? diagram.readPalette(diagramId) : noDiagramHost)
    }),

    ask_user_choice: tool({
      description:
        "当需要用户在多个方案之间抉择（如 A 还是 B）、或缺少关键信息无法继续时，调用本工具生成一张选择卡片。调用后本轮立即停止：面板展示选项按钮与手动输入框，用户点选或输入后会自动作为下一轮输入继续对话。不要在追问的同时提交 model_propose_changes；选项至少 2 个、最多 4 个，每项给出 label 与一句话 description。",
      inputSchema: jsonSchema<AskUserChoiceArgs>({
        type: "object",
        properties: {
          question: { type: "string", description: "向用户提出的问题（一句话）" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string", description: "选项短标题（如 A 方案名称）" },
                description: { type: "string", description: "选项的一句话说明" }
              },
              required: ["label"],
              additionalProperties: false
            }
          },
          allowCustomInput: { type: "boolean", description: "是否允许手动输入其他答案，默认 true" }
        },
        required: ["question", "options"],
        additionalProperties: false
      }),
      execute: async ({ question, options }: AskUserChoiceArgs) =>
        `已向用户发起选择：「${question}」（${options.length} 个选项），等待用户回答。`
    })
  };

  // 聊天模式只给读取类工具：模型没有可调用的写入口，从能力上保证不改模型、也出不了提案卡片
  if (expertReadOnly) {
    // 固定白名单：后续增加写工具或追问工具时，不会自动授予专家。
    const allowed = new Set([
      "model_get_tree", "model_search", "model_get_element", "model_get_children", "model_get_relationships",
      "model_get_properties", "model_get_creatable_element_types", "text_read_sysml", "text_validate",
      "diagram_list", "diagram_read_shapes", "diagram_read_palette"
    ]);
    return Object.fromEntries(Object.entries(readOnlyTools).filter(([name]) => allowed.has(name)));
  }
  if (permissionMode === "chat") return readOnlyTools;

  const changeTools = {
    // 编辑模式直接执行，提案模式生成待确认提案；两者共用同一套操作字段与校验
    ...(permissionMode === "edit"
      ? {
          model_apply_changes: tool({
            description:
              "编辑模式直接写入，一次最多12项，按依赖合批，不重复成功操作。create-element需name/elementType/containerId；update-property需elementId/propertyName/propertyKey/oldValue/newValue；delete-element需elementId且不可撤销。类型、属性key和旧值必须来自查询。create-shape需diagramId/elementConfigId/name；place-shape需diagramId/elementId；create-connector需diagramId/elementConfigId/sourceShapeId/targetShapeId。结果返回新模型/图形ID供后续复用。" +
              REFERENCE_AND_LAYOUT_RULES,
            inputSchema: jsonSchema<ApplyChangesArgs>({
              type: "object",
              properties: {
                title: { type: "string", description: "这次改动的简短标题" },
                operations: { type: "array", minItems: 1, maxItems: MAX_DIRECT_OPERATIONS, items: buildOperationSchema() }
              },
              required: ["title", "operations"],
              additionalProperties: false
            }),
            execute: async ({ title, operations }: ApplyChangesArgs, { abortSignal }) => {
              const executor = getAiAssistantHost().editExecutor;
              if (!executor) return "当前宿主不支持直接执行模型变更，请切换到提案模式";
              if (operations.length > MAX_DIRECT_OPERATIONS) {
                return `一次最多执行 ${MAX_DIRECT_OPERATIONS} 项操作，本次提交了 ${operations.length} 项；请拆分后重试`;
              }

              // 与提案同一套校验：缺字段的项不会被执行，原因回给模型让它补齐
              const { operations: normalized, errors } = normalizeOperations(operations);
              if (errors.length)
                throw new Error(`有 ${errors.length} 项操作参数不完整，未执行任何改动：\n${errors.join("\n")}\n请补齐参数后重新提交。`);
              if (!normalized.length) return "没有可执行的操作，请检查 operations 是否为空。";

              return executor.apply(normalized, { title, signal: abortSignal });
            }
          })
        }
      : {
          model_propose_changes: createProposeChangesTool(),
          model_present_plan: createPresentPlanTool()
        })
  };

  return { ...readOnlyTools, ...changeTools };
}
