import { nanoid } from "nanoid";
import { tryGetAiAssistantHost } from "../host";
import type { AiPermissionMode, AiProviderProfile, AiProviderSettings, AiSkill } from "../types";

/**
 * 供应商预设：默认 Command Code，另含常见厂商、本地推理与自定义入口。
 *
 * extraHeaders 里的 `${session}` 在创建配置时会被替换成随机会话 ID：
 * OpenCode Go 网关要求 `x-opencode-session`，缺失会直接 400 MissingSessionID。
 */
export const AI_PROVIDER_PRESETS: Array<Omit<AiProviderProfile, "id">> = [
  {
    name: "Command Code",
    baseURL: "https://api.commandcode.ai/provider/v1",
    model: "deepseek/deepseek-v4-flash",
    contextLength: 1000000
  },
  {
    name: "OpenCode Go",
    baseURL: "https://opencode.ai/zen/go/v1",
    model: "gpt-6-luna",
    extraHeaders: "x-opencode-session: ${session}"
  },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "千问 Qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "月之暗面 Kimi", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { name: "MiniMax", baseURL: "https://api.minimax.chat/v1", model: "MiniMax-Text-01" },
  { name: "本地 Ollama", baseURL: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b" },
  { name: "内网 vLLM", baseURL: "http://localhost:8000/v1", model: "Qwen2.5-14B-Instruct" },
  { name: "自定义 / Custom", baseURL: "", model: "" }
];

/** 推理强度选项（对应请求体的 reasoning_effort） */
export const AI_EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最高" }
];

/**
 * 建模指引技能正文：内置预设与默认启用技能共用。
 *
 * 只补充系统提示基础规则未覆盖的建模语义与边界：九大图各自要点、类型与使用的具体判据、
 * 追溯关系怎么选，以及图表创建与画布操作的流程；不重复规则里已有的工具约束、
 * “关系落成模型语义”“数量以真实属性为准”等要求。随每轮请求注入，控制在 8000 字软上限内。
 */
const SYSML_MODELING_CONTENT = `SysML 建模指引（M-Design）。补充基础规则未覆盖的建模语义与边界。

九大图与各自要点：
- 包图：用包组织模型结构，表达包导入/元素导入与依赖。
- 模块定义图（BDD）：定义模块（类型）与分类层级；组合、聚合、关联、泛化表达结构关系。
- 内部模块图（IBD）：拆开模块内部——部件属性、值属性、端口、连接器、项流，是“使用”层。
- 参数图：约束属性绑定约束模块，约束参数连接值属性/部件属性，有效性度量与目标函数表达考核指标。
- 需求图：需求条目（功能/性能/接口/设计约束等细分）与追溯关系。
- 用例图：执行者与用例、包含/扩展，描述对外能力；用例是能力声明，别当结构模块。
- 活动图：判断与合并成对、分支与集合成对；责任划分用泳道。
- 状态机图：必须有起始状态；把“处于”建状态，把“做”建动作。
- 序列图：生命线对应参与对象，消息自上而下；条件用选择操作符、循环用循环操作符。

类型与使用：模块（Block）是类型，部件属性（PartProperty）是类型的使用。“车有发动机和轮子”＝车下面的部件属性引用对应模块；“两个轮子”用部件属性的多重度 2 表达，两个有独立名称或角色的轮子才建两个具名部件属性。

追溯关系怎么选：满足＝设计元素满足需求；派生需求＝需求派生需求；验证＝测试用例验证需求；精化与追踪是补充追溯。按用户描述的语义选择，不一律用关联。

图表创建：助手可以新建图表。先确定所属容器，调用 model_get_creatable_element_types 查询支持的图表类型（名称带 [图表] 标记），再用 create-element 创建，elementType 逐字使用查询结果。创建后会请求宿主打开图表；用 diagram_list 确认目标图表已打开及其 diagramId，再读取 diagram_read_palette 和 diagram_read_shapes 进行画布操作。不能仅凭创建成功就宣称图表已打开或布局已完成。

上图与布局：已有模型用 place-shape 上图；create-shape 会新建模型，避免重复创建。用 create-connector 连接真实图形，组合菱形位于整体端，泛化空心三角指向父类型。连组合线可能自动生成部件属性，应读取结果后补齐类型与多重度，避免重复建部件。arrange-shapes 的 layout=auto 使用宿主关系布局，shapeIds 指定本次目标图形；省略时只整理本批新建图形。完成后读回图形与模型关系，核对连线方向、多重度和布局结果。`;

/** 内置建模指引技能：加载设置时确保存在并刷新到最新版本，界面不可删除、不可编辑（可停用） */
const SYSML_MODELING_SKILL: Omit<AiSkill, "id"> = {
  name: "sysml-modeling",
  description: "SysML 建模指引：图表创建、上图与布局、类型与使用分离、关系与追溯规范",
  content: SYSML_MODELING_CONTENT,
  enabled: true,
  builtin: true
};

/** 参考 https://github.com/anthropics/skills/tree/main/skills/skill-creator，适配插件可用工具。 */
const SKILL_CREATOR: Omit<AiSkill, "id"> = {
  name: "skill-creator",
  description: "通过对话创建和改进技能：明确用途、编写指令、设计示例并迭代完善",
  enabled: false,
  builtin: true,
  content: `你是技能创建助手。帮助用户将常用工作流程整理成可重复调用的技能。
先从对话提取目标、触发场景、输入和期望输出；仅追问缺失的关键信息。用户只给出“请帮我创建一个可以实现「……」的技能”时，先询问具体要实现什么，不把占位符当需求。
明确需求后，起草技能名称、简短说明和完整指令。名称使用 2–32 位小写字母、数字或连字符；说明应写清何时调用、解决什么问题；正文包括输入要求、执行步骤、输出格式、异常处理和完成标准。解释规则的原因，避免堆砌不必要的限制。
根据任务准备 2–3 个实际使用示例及预期结果，覆盖正常情况和关键边界。只能使用当前真实可用的工具验证；未执行的案例明确标为待验证。根据用户反馈迭代，不虚构评测结果。
最终给出完整 SKILL.md 文本，包含 name、description 的 YAML frontmatter 和 Markdown 指令正文，便于用户保存和复用。
当前插件技能是名称、说明、指令正文组成的文本配置；不要假设有终端、文件写入、子代理、打包或技能保存工具。输出正文不等于已经保存或安装，只有真实工具返回成功才可宣称已完成对应操作。`
};

/** M-Design 专家定义创建指引；按需调用，不依赖第三方宿主的注册脚本。 */
const EXPERT_MANAGER: Omit<AiSkill, "id"> = {
  name: "expert-manager",
  description: "通过对话创建和完善专家：结合行业背景定义擅长领域、工作流程和交付标准",
  enabled: false,
  builtin: true,
  content: `你是 M-Design 专家创建助手，帮助用户形成可复用的专家定义。
先了解用户希望创建什么专家、擅长哪些领域、实际使用场景，以及用户的行业背景和相关经验。XXX、XXXXX、[请补充你的行业背景、相关经验] 都是待填写占位符，不能当成真实信息。仅追问关键缺项，不编造用户经历或专家资质。
从已有资料提取角色定位、核心能力、工作流程、输入输出规范和限制。单个角色定义为专家；明确需要多个角色协作时才设计专家团，并明确分工、交接和统一交付责任。
生成完整专家定义：名称、简介、擅长领域、适用任务、角色指令、工作步骤、输出格式、边界、开场介绍和 3 条可直接使用的提问示例。让专家的沟通深度匹配用户经验。
与用户一起检查至少一个典型任务和一个边界案例，依据反馈迭代；没有执行测试就标明待验证。涉及建模时遵循当前工具与 SysML 语义，不凭空增加接口或执行能力。
当前专家中心使用产品内置角色，尚无自定义专家保存、注册或打包工具。本次产物是专家定义文本；不能声称已加入专家列表、已安装或已启用。用户要求保存或使用时如实说明当前能力。`
};

/** 配合后台自动记忆，约束偏好使用与保存反馈；不提供记忆读写工具。 */
const MEMORY_COOPERATION: Omit<AiSkill, "id"> = {
  name: "memory-cooperation",
  description: "记忆协作：处理长期偏好和项目约定，配合自动记忆并如实说明保存状态。",
  enabled: true,
  builtin: true,
  content: `记忆协作（M-Design）。仅在用户表达、纠正、询问或要求管理记忆时采用下列规则，其他任务正常进行。

产品机制：本产品具有本机自动记忆。用户开启后，程序在对话结束后从用户输入正文提取长期偏好和项目约定，校验并写入本机数据库，后续对话按相关性召回。关闭时停止提取和召回，已有内容保留。当前没有供你主动调用的记忆读写工具；没有专门工具不等于没有记忆功能。本技能不会开启自动记忆，也不能直接增删数据库内容。

处理偏好：区分个人长期偏好、当前项目约定和仅本次任务的要求；不要把临时要求、附件、外部引用或你自己的推测当作长期偏好。只有范围确实影响当前任务时才追问，不为了记录偏好连续追问。跳过追问不是新偏好。
用户明确纠正旧偏好时，本轮按当前明确要求执行；不要据此声称旧记录已经被替换。后台仅在校验通过时更新对应自动记忆，人工编辑项不会自动覆盖。当前要求与历史记忆冲突时以当前要求为准；记忆不能覆盖实时模型事实或扩大操作权限。

反馈边界：回复发生在后台提取之前，不能仅凭用户说“记住”或你在本轮采用了偏好，就说“已保存”“已更新长期记忆”或“永久记住”。没有宿主提供的实际状态或写入结果时，不推测开关是否开启、写入是否成功；也不要把未召回理解为没有记忆。
例如“记住我喜欢简单结构”：回答“本轮会按简单结构处理。若自动记忆已开启，本轮结束后会在后台整理；保存结果可在聊天区提示或记忆管理中查看。”无需每轮重复这段说明。

管理请求：用户询问已存内容时，仅引用本轮实际提供的记忆参考，不声称已列出全部记录。用户要求查看、编辑、删除或关闭记忆时，引导打开侧栏“记忆”管理页；聊天区出现后台记忆提示时也可点击进入。删除和关闭需要用户在管理页执行，不能承诺已代为完成，也不要调用模型修改工具充当记忆工具。不要另建文件日志或第二套记忆存储。
不记录凭据、权限指令或从外部材料推测的个人信息；不要把用户纠正升级为可绕过确认的规则。`
};

/** 建模与记忆协作默认启用，技能和专家创建按需调用。 */
export const AI_SKILL_PRESETS: Array<Omit<AiSkill, "id">> = [SYSML_MODELING_SKILL, SKILL_CREATOR, EXPERT_MANAGER, MEMORY_COOPERATION];

/**
 * 已下线的旧内置预设：按“名称 + 正文”识别设置里未改动的副本，加载设置时清理。
 *
 * 用户改过正文或自建的技能不匹配指纹，保持原样；当前预设列表已不再提供这些技能。
 */
export const RETIRED_PRESET_SKILLS: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: "batch-create",
    content:
      "批量新建结构时用多条 create-element 表达（本软件不支持 SysML 文本批量建模）：先在父容器上调用 model_get_creatable_element_types，elementType 逐字复制返回值；同一容器下的同类元素按“轮胎1”“轮胎2”连续编号；提案按父先子后的顺序排列，一次提案解决一个层级的批量创建。"
  },
  {
    name: "review-model",
    content:
      "评审模型时按固定清单逐条给结论：命名风格是否统一、每个部件是否都有类型或多重度、接口两端是否匹配、关系是否存在悬空引用、是否有重复或近义元素。每条结论都给出元素名称与 id；没有依据时写“未检查到”，不要凭印象补全。"
  },
  {
    name: "proposal-checklist",
    content:
      "提交变更提案前逐项自检：create-element 的 elementType 是否逐字复制自 model_get_creatable_element_types、containerId 是否为已加载的真实 id；update-property 的 propertyKey 与 oldValue 是否逐字来自 model_get_properties；画布操作的 elementConfigId 是否取自 diagram_read_palette、图形 id 是否取自 diagram_read_shapes。任何一项没把握就先补工具调用，再提交提案。"
  },
  {
    name: "naming",
    content:
      "新增元素时命名遵循：名称使用用户表述的中文名；同一容器批量创建同名元素时用连续编号（如“轮胎1”“轮胎2”）；不要给名称加英文前缀或类型后缀。遇到可能与既有元素重名时，先用 model_search 确认是否存在，已存在就复用而不是新建。"
  }
];

/** 权限模式选项：控制 AI 能不能改模型、要不要先出提案；description 为一行短说明 */
export const AI_PERMISSION_MODES: Array<{ value: AiPermissionMode; label: string; description: string }> = [
  { value: "chat", label: "聊天", description: "只读问答，可给方案但不改模型" },
  { value: "proposal", label: "提案", description: "生成提案，确认后才执行" },
  { value: "edit", label: "编辑", description: "直接执行变更，不再逐条确认" }
];

/** 权限模式的缺省值：审批模式，兼容没有该字段的旧设置 */
export const DEFAULT_PERMISSION_MODE: AiPermissionMode = "proposal";

/** 读取当前权限模式；非法或缺省值回退到提案模式 */
export function getPermissionMode(settings: AiProviderSettings): AiPermissionMode {
  const mode = settings.permissionMode;
  return AI_PERMISSION_MODES.some(item => item.value === mode) ? (mode as AiPermissionMode) : DEFAULT_PERMISSION_MODE;
}

const LOCAL_STORAGE_KEY = "ai-assistant:provider-settings";

/** 宿主存储中 AI 助手配置的键名。 */
export const AI_SETTINGS_STORAGE_KEY = "aiProvider";

function readStoredSettings(): AiProviderSettings | null {
  const adapter = tryGetAiAssistantHost()?.settingsStorage;
  if (adapter) return adapter.get();

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AiProviderSettings) : null;
  } catch {
    return null;
  }
}

function persistSettings(settings: AiProviderSettings): void {
  const adapter = tryGetAiAssistantHost()?.settingsStorage;
  if (adapter) {
    adapter.set(settings);
    return;
  }

  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error("[ai-assistant] 保存供应商设置失败", error);
  }
}

/** 预设里 `${session}` 占位：创建配置时替换为随机会话 ID（部分网关要求会话头） */
const SESSION_PLACEHOLDER = "${session}";

/** 把预设里的会话占位替换成随机 ID；没有额外头时返回 undefined */
export function resolvePresetHeaders(preset: Omit<AiProviderProfile, "id">): string | undefined {
  return preset.extraHeaders?.replaceAll(SESSION_PLACEHOLDER, `mdesign-${nanoid(16)}`);
}

/** 创建基于预设的新供应商配置；预设里的会话占位符会替换成随机 ID */
export function createProfileFromPreset(preset: Omit<AiProviderProfile, "id">): AiProviderProfile {
  const extraHeaders = resolvePresetHeaders(preset);
  return { id: nanoid(), ...preset, ...(extraHeaders ? { extraHeaders } : {}) };
}

/**
 * 确保设置里存在最新版本的内置技能。
 *
 * 内置技能随产品分发：缺失时补齐，存在时把名称、说明与正文刷新为当前版本并标记 builtin，
 * 保留用户对启用开关的选择（可停用）；用户自建技能与其他字段原样保留。
 * 没有任何变化时返回原对象，避免无谓重建。
 *
 * @param settings 供应商设置
 * @returns 含最新内置技能的设置（必要时为新对象）
 */
export function ensureBuiltinSkills(settings: AiProviderSettings): AiProviderSettings {
  let next = settings.skills ?? [];
  let changed = false;
  for (const preset of AI_SKILL_PRESETS) {
    const id = `builtin-${preset.name}`;
    const index = next.findIndex(skill => skill.id === id || skill.name === preset.name);
    const existing = index >= 0 ? next[index] : undefined;
    const latest: AiSkill = { id, ...preset, enabled: existing ? existing.enabled : preset.enabled };
    if (
      existing &&
      existing.id === id &&
      existing.name === latest.name &&
      existing.description === latest.description &&
      existing.content === latest.content &&
      existing.builtin === true
    )
      continue;
    if (!changed) next = [...next];
    changed = true;
    if (existing) next[index] = latest;
    else next.push(latest);
  }
  return changed ? { ...settings, skills: next } : settings;
}

/**
 * 清理设置里已下线预设的副本。
 *
 * 只有名称与正文都与旧预设完全一致的副本会被删除；改过内容或用户自建的技能保留。
 * 没有任何命中时返回原对象，避免无谓重建。
 *
 * @param settings 供应商设置
 * @returns 清理后的设置（必要时为新对象）
 */
export function pruneLegacyPresetSkills(settings: AiProviderSettings): AiProviderSettings {
  const skills = settings.skills ?? [];
  const kept = skills.filter(
    skill => !RETIRED_PRESET_SKILLS.some(retired => retired.name === skill.name && retired.content === skill.content)
  );
  if (kept.length === skills.length) return settings;
  return { ...settings, skills: kept.length ? kept : undefined };
}

/** 读取供应商设置；未配置时返回默认预设；两者都会确保内置技能为最新版本并清理旧预设副本 */
export function loadAiProviderSettings(): AiProviderSettings {
  const stored = readStoredSettings();
  if (stored?.profiles?.length) return pruneLegacyPresetSkills(ensureBuiltinSkills(stored));

  const profile = createProfileFromPreset(AI_PROVIDER_PRESETS[0]);
  return ensureBuiltinSkills({ activeProfileId: profile.id, profiles: [profile] });
}

/** 保存供应商设置 */
export function saveAiProviderSettings(settings: AiProviderSettings): void {
  persistSettings(settings);
}

/**
 * 重新读取设置后只更新目标字段，避免覆盖会话持久化产生的增量。
 *
 * 返回浅拷贝：部分存储适配器（宿主缓存、测试用的内存 Map）会把同一个对象
 * 原样返回，若把同一引用再赋回 `ref`，变更在原始对象上完成、代理收不到通知，
 * 界面就不会刷新；换一个新对象交付给调用方即可稳定触发更新。
 */
export function updateAiProviderSettings(update: (settings: AiProviderSettings) => void): AiProviderSettings {
  const settings = loadAiProviderSettings();
  update(settings);
  saveAiProviderSettings(settings);
  return { ...settings };
}

/** 获取当前启用的供应商（缺省回退到第一个） */
export function getActiveProfile(settings: AiProviderSettings): AiProviderProfile | undefined {
  return settings.profiles.find(profile => profile.id === settings.activeProfileId) ?? settings.profiles[0];
}

/** 收藏槽位上限：对应 Ctrl+1–9 */
export const FAVORITE_SLOTS = 9;

/**
 * 收藏键：`profileId::modelId`。
 *
 * modelId 自身可能含 "/"（如 deepseek/deepseek-v4-flash），所以分隔符用 "::"，
 * 解析时只按第一个 "::" 切开，模型 id 原样保留。
 */
export function favoriteModelKey(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

/** 解析收藏键；格式不合法时返回 undefined */
export function parseFavoriteModelKey(key: string): { profileId: string; modelId: string } | undefined {
  const index = key.indexOf("::");
  if (index <= 0) return undefined;

  const profileId = key.slice(0, index);
  const modelId = key.slice(index + 2);
  return profileId && modelId ? { profileId, modelId } : undefined;
}

/**
 * 切换收藏（纯函数，便于测试）。
 *
 * 新收藏追加到末尾，数组序号就是 Ctrl+N 的槽位号；取消收藏会让后续槽位前移。
 */
export function toggleFavoriteModelKey(keys: readonly string[] | undefined, key: string): string[] {
  const list = keys ? [...keys] : [];
  const index = list.indexOf(key);

  if (index >= 0) list.splice(index, 1);
  else list.push(key);

  return list;
}

/** 判断某模型是否已收藏 */
export function isFavoriteModel(settings: AiProviderSettings, profileId: string, modelId: string): boolean {
  return (settings.favoriteModels ?? []).includes(favoriteModelKey(profileId, modelId));
}

/** 切换收藏并落盘 */
export function toggleFavoriteModel(profileId: string, modelId: string): AiProviderSettings {
  const key = favoriteModelKey(profileId, modelId);
  return updateAiProviderSettings(settings => {
    settings.favoriteModels = toggleFavoriteModelKey(settings.favoriteModels, key);
  });
}
