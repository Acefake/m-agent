import type { AiExecutionStrategy, AiExpertRole } from "../types";

/** 内置专家名录，供独立选择与专家团分工共用。 */
export const SYSML_EXPERTS: Array<{ role: AiExpertRole; name: string; description: string; symbol: string }> = [
  { role: "lead", name: "建模负责人", description: "拆解任务、安排分工，统一交付模型与图表。", symbol: "统" },
  { role: "requirements", name: "需求专家", description: "梳理目标、业务约束、缺失信息与验收条件。", symbol: "需" },
  { role: "semantics", name: "SysML 语义专家", description: "核对类型、部件、多重性及关系方向。", symbol: "模" },
  { role: "layout", name: "图形布局专家", description: "规划图种、图形组织、连线路径和布局。", symbol: "图" },
  { role: "checker", name: "模型检查专家", description: "检查方案，提交后回读模型与执行结果。", symbol: "检" }
];

/** 将专家角色转换为可持久化的独立执行策略。 */
export function expertStrategy(role: AiExpertRole): AiExecutionStrategy {
  return `expert:${role}`;
}

/** 解析用户独立选择的专家；普通助手和专家团没有单专家角色。 */
export function selectedExpert(strategy: AiExecutionStrategy | undefined): (typeof SYSML_EXPERTS)[number] | undefined {
  return SYSML_EXPERTS.find(expert => expertStrategy(expert.role) === strategy);
}

/** 在会话选择入口校验策略，拒绝未知或外部传入的角色值。 */
export function isExecutionStrategy(value: unknown): value is AiExecutionStrategy {
  return value === "assistant" || value === "sysml-team" || SYSML_EXPERTS.some(expert => expertStrategy(expert.role) === value);
}

/** 单专家直接回应用户，沿用本轮工具权限，不参与专家团调度协议。 */
export function standaloneExpertTask(strategy: AiExecutionStrategy | undefined): { instructions: string; readOnly: false } | undefined {
  const expert = selectedExpert(strategy);
  if (!expert) return undefined;
  return {
    instructions: `你是${expert.name}。你的专业职责是：${expert.description}\n本轮由你独立处理用户任务，直接用自然语言回答或按当前权限使用工具。不要安排其他专家、模拟专家团协作或输出团队调度协议。当前聊天、提案或编辑模式的权限约束仍然适用。`,
    readOnly: false
  };
}
