import { nanoid } from "nanoid";
import type { AiSkill } from "./types";

/** 技能调用名的形态：2–32 位小写字母、数字或连字符 */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]{2,32}$/;

/**
 * 输入区里 /name 形态的技能调用。
 *
 * 前后都排除单词字符与斜杠：路径（src/renderer）、URL 片段、斜杠命令不会被当成技能调用；
 * 两侧的可选空白一并吃掉，替换成单个空格，避免留下双空格或空行。
 */
const SKILL_TOKEN_PATTERN = /[ \t]*(?<![\w/])\/([a-z0-9-]{2,32})(?![\w-])[ \t]*/g;

/** 技能正文总量的软上限：超出时设置界面提示，不阻断保存 */
export const SKILL_CONTENT_WARN_LENGTH = 8000;

/** 规范化技能名（去空白、转小写），供设置界面失焦时整理输入 */
export function normalizeSkillName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 校验技能名；返回中文错误信息，合法时返回 undefined */
export function validateSkillName(name: string, skills: AiSkill[], currentId?: string): string | undefined {
  if (!name) return "请填写技能名";
  if (!SKILL_NAME_PATTERN.test(name)) return "技能名只能是 2–32 位小写字母、数字或连字符";
  if (skills.some(skill => skill.name === name && skill.id !== currentId)) return "技能名已存在";
  return undefined;
}

/** 新建一个技能；设置界面用它初始化表单 */
export function createSkill(initial?: Partial<AiSkill>): AiSkill {
  return { id: nanoid(), name: "", description: "", content: "", enabled: true, ...initial };
}

/**
 * 从用户输入里抽出 /name 形式的技能调用。
 *
 * 只有与已配置技能同名的才被摘出——其余 /xxx 保持原样（可能是斜杠命令或路径）；
 * 同名重复调用只记一次。返回去掉调用名后的正文与技能名列表。
 */
export function extractSkills(content: string, skills: AiSkill[]): { text: string; skillNames: string[] } {
  const known = new Set(skills.map(skill => skill.name));
  const skillNames: string[] = [];

  const text = content
    .replace(SKILL_TOKEN_PATTERN, (match, name: string) => {
      // 未知的 /xxx 保持原样（可能是斜杠命令或路径）；已知技能整段摘掉，重复调用只记一次
      if (!known.has(name)) return match;
      if (!skillNames.includes(name)) skillNames.push(name);
      return " ";
    })
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, skillNames };
}

/** 本轮要注入系统提示的技能：默认启用的，加上本轮用 /name 显式调用的 */
export function resolveActiveSkills(skills: AiSkill[], invokedNames: string[] = []): AiSkill[] {
  return skills.filter(skill => skill.enabled || invokedNames.includes(skill.name));
}

/** 默认启用技能的正文总量：设置界面据此提示上下文占用 */
export function totalSkillContentLength(skills: AiSkill[]): number {
  return skills.filter(skill => skill.enabled).reduce((sum, skill) => sum + skill.content.length, 0);
}
