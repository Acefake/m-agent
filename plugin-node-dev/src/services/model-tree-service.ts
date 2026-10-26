import { transaction, ResData } from "../preload/host-api";
import type { CreationType } from "../preload/host-api";
import type { CreateNodeDto } from "../controllers/dto";

function flattenTypes(items: CreationType[]): CreationType[] {
  if (!Array.isArray(items)) throw new Error("宿主未返回可创建类型列表");
  return items.flatMap(item => (item.children?.length ? flattenTypes(item.children) : item.metaclass ? [item] : []));
}

function sameStereotypes(left: string[], right: string[]): boolean {
  const sorted = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sorted[index]);
}

/** 复用宿主创建行为和 Step，返回实际主模型 ID。 */
export async function createNode(dto: CreateNodeDto) {
  if (!dto.name.trim() || dto.name.length > 160) throw new Error("节点名称应为1–160个字符");
  return transaction({ projectId: dto.projectId }, async st => {
    const parent = await st.nodeService.getNode(dto.parentId);
    if (!parent) throw new Error("目标父节点不存在");
    if (parent.from !== 3 || parent.isEncrypted || parent.hiddenStatus) throw new Error("目标节点不可编辑");
    const types = flattenTypes(
      await st.nodeService.getCanCreateChildTypes({
        projectId: dto.projectId,
        instanceId: dto.parentId,
        hasSysMLPermission: dto.hasSysMLPermission
      })
    );
    const selected = types.find(
      item => item.metaclass === dto.metaclass && sameStereotypes(item.appliedStereotypes || item.sts || [], dto.stereotypes)
    );
    if (!selected || selected.disabled) throw new Error("当前容器不允许创建指定元类和构造型");
    if (
      /Diagram|Relationship|Association|Dependency|Connector|Generalization|Realization|Abstraction/.test(dto.metaclass) ||
      dto.stereotypes.some(value => /Diagram/.test(value))
    )
      throw new Error("第一版仅创建普通模型树元素，不创建图表或关系");
    const children = await st.nodeService.getNodeChildren(dto.parentId);
    if (children.some(child => child.name === dto.name.trim())) throw new Error("目标容器下已存在同名节点，请查询现有结构后续建");
    const result = await st.modelService.createModel({
      projectId: dto.projectId,
      parentId: dto.parentId,
      type: 0,
      metaclass: selected.metaclass,
      applyStereotypes: dto.stereotypes,
      customName: dto.name.trim(),
      operation: selected.operation,
      isAutoOpenDiagram: false
    });
    const created = result.createdInstance;
    if (!created?.id) throw new Error("宿主创建接口未返回 createdInstance，不能确认创建结果");
    st.step.autoOpenDiagram = false;
    return new ResData({
      id: created.id,
      name: created.name,
      metaclass: created.metaclass,
      parentId: dto.parentId
    });
  });
}
