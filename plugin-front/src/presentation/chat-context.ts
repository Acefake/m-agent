import { ref } from "vue";
import type { AiModelMention } from "../ai-assistant/host";

/**
 * “添加到聊天”的节点引用队列：模型树右键子菜单与聊天面板之间的桥。
 *
 * 动作侧入队（面板未挂载也不丢节点），面板挂载或队列变化时整体消费；
 * 面板把这枚节点以 @[名称](id) 的引用块追加到输入区（见 panel/index.vue）。
 */
const pendingMentions = ref<AiModelMention[]>([]);

/** 待消费节点（面板 watch 用；直接读写请走 enqueue / drain） */
export const chatMentionQueue = pendingMentions;

export function enqueueChatMention(mention: AiModelMention): void {
  pendingMentions.value = [...pendingMentions.value, mention];
}

/** 取出并清空待加入的节点；没有时返回空数组 */
export function drainChatMentions(): AiModelMention[] {
  if (!pendingMentions.value.length) return [];
  const mentions = pendingMentions.value;
  pendingMentions.value = [];
  return mentions;
}
