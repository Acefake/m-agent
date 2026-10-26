import MarkdownIt, { type StateCore, type Token } from "markdown-it";

/** 面板的 Markdown 渲染器：禁用原始 HTML，自动识别链接，单换行按换行处理 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

type LinkOpenRule = NonNullable<(typeof markdown.renderer.rules)["link_open"]>;

// 外链在新窗口打开，避免打断应用内导航
const renderLinkOpen: LinkOpenRule = (tokens, index, options, _env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noreferrer noopener");
  return self.renderToken(tokens, index, options);
};

markdown.renderer.rules.link_open = renderLinkOpen;

/** 关键词分类：每类对应面板样式表里的一条底色规则 */
interface KeywordRule {
  className: string;
  pattern: RegExp;
}

/**
 * 正文关键词高亮：工具名、命令名、SysML 关键字、A/B 选项、文档名、元素 id。
 *
 * 顺序即优先级（见 collectMatches：重叠时保留先命中的规则），因此按"从具体到泛化"排列，
 * 元素 id 这种几乎能匹配任何小写短串的规则放在最后，避免它抢走更具体的分类。
 */
const KEYWORD_RULES: KeywordRule[] = [
  // 工具名：命名空间前缀的 snake_case，以及提案里的固定操作名
  {
    className: "kw--tool",
    pattern:
      /\b(?:model|text|diagram)_[a-z_]+|\bask_user_choice\b|\b(?:create|update|delete|replace)-(?:element|property|sysml-text|shape|connector)\b|\bplace-shape\b|\barrange-shapes\b/g
  },
  // 命令名：正文里以 / 引导的斜杠命令
  { className: "kw--tool", pattern: /(?<![\w/])\/[a-z][a-z0-9-]{2,}/g },
  // SysML 关键字：只标记带驼峰的多词形式，避免命中英文常用词（如 item、part）
  { className: "kw--sysml", pattern: /\b(?:Part|Item|Interface|Attribute|Action|Requirement|UseCase|Port|State)Definition\b/g },
  // 方案/选项标记：A 方案、方案 B、选项 C
  { className: "kw--option", pattern: /(?:[A-F]\s*方案|方案\s*[A-F]|选项\s*[A-F])(?![A-Za-z0-9])/g },
  // 文本命名空间与文档名：xxx.sysml
  { className: "kw--doc", pattern: /[\w\u4e00-\u9fa5-]+\.sysml\b/g },
  // 元素 id：后端下发的小写短标识，实际是 5–12 位 base36（如 h33f4、ie3ba、21718ad），
  // 不是十六进制（含 a-f 以外的字母），因此只能按"小写字母数字串 + 已知英文词黑名单"来做。
  // 前后不得连 - 或下划线：create-shape、model_propose_changes 这类标识要整段归前面的规则，
  // 不能被拆出 create、shape 之类的片段当成 id（\b 会把连字符当边界，这里不能用它）
  { className: "kw--id", pattern: /(?<![\w-])[a-z0-9]{5,12}(?![\w-])/g }
];

/**
 * 与 id 形态相同、但属于英文单词的排除项（均为 5–12 位小写字母数字串）。
 *
 * id 是后端的短标识，形态上与英文单词无法从语法区分，只能排除已知词：既有常见英文词，
 * 也有工具名与提案操作名的拆片（create、shape、element、container…）和面板里的高频词，
 * 这些词在正文里出现时不该被标成 id。
 * 列表外的单词仍可能被误标，这样的取舍是为了优先保证 h33f4、ie3ba 这类真实 id 能命中。
 */
const ID_LIKE_ENGLISH_WORDS = new Set([
  "about",
  "added",
  "after",
  "again",
  "allow",
  "already",
  "arrange",
  "based",
  "below",
  "cache",
  "canvas",
  "change",
  "changes",
  "click",
  "connector",
  "container",
  "could",
  "create",
  "delete",
  "depth",
  "diagram",
  "element",
  "elements",
  "empty",
  "error",
  "false",
  "field",
  "files",
  "first",
  "found",
  "index",
  "input",
  "items",
  "label",
  "lines",
  "model",
  "nodes",
  "output",
  "panel",
  "place",
  "please",
  "property",
  "props",
  "replace",
  "reset",
  "result",
  "right",
  "search",
  "select",
  "shape",
  "shapes",
  "should",
  "start",
  "state",
  "steps",
  "sysml",
  "table",
  "there",
  "these",
  "those",
  "title",
  "token",
  "tokens",
  "tools",
  "total",
  "trace",
  "types",
  "under",
  "until",
  "update",
  "usage",
  "using",
  "value",
  "where",
  "which",
  "while",
  "would",
  "write"
]);

/** 一处命中：在原文中的区间与所属分类 */
interface KeywordMatch {
  start: number;
  end: number;
  className: string;
  text: string;
}

/** 该命中是否应当保留：id 类命中要排除同形态的英文单词 */
function isMeaningfulMatch(rule: KeywordRule, text: string): boolean {
  return rule.className === "kw--id" ? !ID_LIKE_ENGLISH_WORDS.has(text) : true;
}

/** 收集一处文本里所有规则的命中，重叠时保留先命中的规则，避免叠加两层底色 */
function collectMatches(content: string): KeywordMatch[] {
  const matches: KeywordMatch[] = [];

  KEYWORD_RULES.forEach(rule => {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(content);
    while (match) {
      const text = match[0];
      const start = match.index;
      const end = start + text.length;
      const overlapped = matches.some(item => start < item.end && item.start < end);
      if (!overlapped && isMeaningfulMatch(rule, text)) matches.push({ start, end, className: rule.className, text });
      match = rule.pattern.exec(content);
    }
  });

  return matches.sort((left, right) => left.start - right.start);
}

/** 生成一个行内 token */
function createToken(state: StateCore, type: string, content: string): Token {
  const token = new state.Token(type, "", 0);
  token.content = content;
  return token;
}

/**
 * 把一处关键词文本转成「高亮片段」token 序列。
 *
 * @param content 原文
 * @param state markdown-it 的 core 状态（借用其 Token 构造器）
 * @param out 输出数组
 */
function pushHighlightedText(content: string, state: StateCore, out: Token[]): void {
  const matches = collectMatches(content);
  if (!matches.length) {
    out.push(createToken(state, "text", content));
    return;
  }

  let cursor = 0;
  matches.forEach(item => {
    if (item.start > cursor) out.push(createToken(state, "text", content.slice(cursor, item.start)));

    out.push(createToken(state, "html_inline", `<span class="${item.className}">`));
    out.push(createToken(state, "text", item.text));
    out.push(createToken(state, "html_inline", "</span>"));

    cursor = item.end;
  });

  if (cursor < content.length) out.push(createToken(state, "text", content.slice(cursor)));
}

/** 生成 code_inline 开闭 token（复用原 token 的标记与属性） */
function createCodeToken(state: StateCore, source: Token, type: "code_inline_open" | "code_inline_close"): Token {
  const token = new state.Token(type, "code", type === "code_inline_open" ? 1 : -1);
  token.markup = source.markup;
  token.attrs = source.attrs;
  return token;
}

/** 处理一个行内子 token，返回替换后的 token 序列；无需改动时返回原 token */
function rewriteChild(child: Token, state: StateCore): Token[] | undefined {
  if (child.type === "text" && child.content) {
    const produced: Token[] = [];
    pushHighlightedText(child.content, state, produced);
    const untouched = produced.length === 1 && produced[0].type === "text" && produced[0].content === child.content;
    return untouched ? undefined : produced;
  }

  // 行内代码：id、工具名常被模型写在反引号里，这里拆开并保留 <code> 外壳
  if (child.type === "code_inline" && child.content) {
    const inner: Token[] = [];
    pushHighlightedText(child.content, state, inner);
    if (inner.length === 1 && inner[0].type === "text" && inner[0].content === child.content) return undefined;

    return [createCodeToken(state, child, "code_inline_open"), ...inner, createCodeToken(state, child, "code_inline_close")];
  }

  return undefined;
}

/** 裸 URL（自动识别出的链接文本）：URL 路径不是关键词，整段跳过标记 */
function isBareUrl(text: string): boolean {
  return /^(?:https?:\/\/|ftp:\/\/|www\.|mailto:)/i.test(text);
}

/**
 * 遍历行内 token，把关键词包成 <span class="kw--x">。
 *
 * 普通文本与行内代码都参与标记，代码片段额外保留 <code> 外壳，
 * 这样反引号里的 id / 工具名同样有底色，且不改变原有代码样式。
 */
function markKeywords(state: StateCore): void {
  state.tokens.forEach(token => {
    if (token.type !== "inline" || !token.children?.length) return;

    const next: Token[] = [];
    let replaced = false;
    let linkDepth = 0;
    token.children.forEach(child => {
      if (child.type === "link_close") linkDepth = Math.max(0, linkDepth - 1);

      // 裸 URL 不参与标记：路径由一串 5–12 位小写片段组成，标出来只会是一排假的 id 底色
      const rewritten = linkDepth && isBareUrl(child.content) ? undefined : rewriteChild(child, state);
      if (!rewritten) {
        next.push(child);
      } else {
        replaced = true;
        next.push(...rewritten);
      }

      if (child.type === "link_open") linkDepth += 1;
    });

    if (replaced) token.children = next;
  });
}

markdown.core.ruler.push("ai_keyword_highlight", markKeywords);

/**
 * 把模型返回的 Markdown 文本渲染为 HTML。
 *
 * 原始 HTML 仍处于关闭状态（html: false），模型输出里的标签会被转义；
 * 只有本模块插入的 <span class="kw--x"> 会作为 html_inline 保留，配合面板样式表呈现。
 * 调用方通过 v-html 注入，需保证只在消息渲染处使用。
 */
export function renderMarkdown(content: string): string {
  return markdown.render(content);
}
