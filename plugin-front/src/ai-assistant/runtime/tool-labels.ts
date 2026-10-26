/**
 * 工具名称 → 中文动作说明。
 *
 * 面板（过程步骤）与运行时（失败提示）共用同一份，避免两处文案漂移；
 * 不在表里的工具直接显示原始名称，便于定位新工具。
 */
export const TOOL_LABELS: Record<string, string> = {
  model_get_tree: "读取模型树",
  model_search: "搜索元素",
  model_get_element: "查看元素",
  model_get_children: "展开子元素",
  model_get_relationships: "查看关系",
  model_get_properties: "查看属性",
  model_get_creatable_element_types: "获取可创建类型",
  text_read_sysml: "读取 SysML 文本",
  text_validate: "校验 SysML 文本",
  diagram_list: "列出图表",
  diagram_read_shapes: "读取画布图形",
  diagram_read_palette: "读取可创建图形",
  model_propose_changes: "生成变更提案",
  model_apply_changes: "直接执行变更",
  model_present_plan: "生成分步计划",
  ask_user_choice: "发起选择"
};

/** 取工具的中文动作说明；未收录时回退原始名称 */
export function toolLabelOf(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
