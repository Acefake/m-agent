import { Action, notify } from "../host/runtime";
import { pluginActive } from "../host/lifecycle";
import { setAgentPanelActive } from "./open-agent";
import { enqueueChatMention } from "../presentation/chat-context";

/** 模型树右键节点的最小接口（GraphNode 的子集） */
interface HostGraphNode {
  id?: string;
  data?: { id?: string; name?: string; metaclass?: string | null };
}

/**
 * 模型树右键“AI 建模助手 → 添加到聊天”的入口动作。
 *
 * 把右键节点的名称与 id 作为引用上下文加入聊天：先打开右侧面板，
 * 再把节点入队（面板未挂载也不丢），由面板以 @[名称](id) 的引用块追加到输入区。
 */
export class AddToChatAction extends Action {
  keyName = "agent.AddToChatAction";

  onTreeMenuClick(graphNode?: HostGraphNode): void {
    if (!pluginActive.value) return;

    const mention = readMention(graphNode);
    if (!mention) {
      notify({ title: "AI 建模助手", message: "该节点没有可引用的模型 id，无法添加到聊天", type: "warning", forbidTranslate: true });
      return;
    }

    setAgentPanelActive(true);
    enqueueChatMention(mention);
  }
}

/** 从右键节点取引用信息：名称缺省用 id，类型缺省标为未知 */
function readMention(node?: HostGraphNode): { id: string; title: string; type: string } | undefined {
  const id = node?.data?.id || node?.id;
  if (!id) return undefined;
  return {
    id,
    title: node?.data?.name || id,
    type: String(node?.data?.metaclass || "未知类型")
  };
}
