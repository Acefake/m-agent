<template>
  <svg
    v-if="brand"
    class="brand-logo"
    viewBox="0 0 24 24"
    role="img"
    :aria-label="name"
    :style="accentColor ? { color: accentColor } : undefined"
  >
    <path
      v-for="(element, index) in brand.elements"
      :key="index"
      v-bind="element.attrs"
      fill="currentColor"
    />
  </svg>
  <span
    v-else
    class="brand-logo brand-logo--monogram"
    :aria-label="name"
  >{{ monogram }}</span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { resolveBrand } from "./brands";
import { vendorMonogram } from "../../../ai-assistant/provider/vendor";

const props = defineProps<{
  /**
   * 识别品牌的标识：供应商名称、profile 名称，或模型 id 的模型名段。
   *
   * 命中内置品牌表时渲染官方 logo，未命中回退首字母色块，
   * 保证内网自研或自定义供应商也能显示标识。
   */
  name: string;
  /**
   * 补充识别来源，仅在 name 未命中时尝试。
   *
   * 典型用法：同一供应商下逐行展示模型（name 传模型名、hint 传供应商名），
   * 这样 claude-* 能显示自己的 logo，而供应商自有的模型仍回退到供应商标识。
   */
  hint?: string;
  /**
   * 是否用官方品牌色渲染。
   *
   * 缺省跟随文字颜色：品牌主色是品牌方规定的完整色值，直接用容易和界面主题打架，
   * 只在需要强调品牌身份的位置（如设置里的品牌行、模型选择器）开启。
   */
  brandColor?: boolean;
}>();

/** 命中品牌时返回其数据；未命中由模板回退首字母文字 */
const brand = computed(() => resolveBrand(props.name) ?? resolveBrand(props.hint));
/** 首字母文字优先用命中的品牌名，其次回退 name 本身 */
const label = computed(() => (brand.value ? brand.value.slug : props.name));
const monogram = computed(() => vendorMonogram(label.value));

/**
 * 生效的品牌色：过浅的主色在白底上几乎不可见（如 OpenCode 的近白 #F1ECEC），
 * 此时返回 undefined，回退为跟随外层文字色，由使用处决定墨色。
 */
const accentColor = computed(() => (props.brandColor ? readableBrandColor(brand.value?.hex) : undefined));

/** 品牌主色的白底可读性守卫：按感知亮度判断 */
function readableBrandColor(hex: string | undefined): string | undefined {
  if (!hex) return undefined;

  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return hex;

  const [r, g, b] = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.82 ? undefined : hex;
}
</script>

<style scoped>
/*
 * 尺寸交给外层通过 font-size 控制，宽高固定 1em；
 * 用 :where 把外层样式表的优先级降为 0，避免各处重复覆盖宽高。
 */
:where(.brand-logo) {
  flex-shrink: 0;
  width: 1em;
  height: 1em;
}

/* 未收录品牌：只显示首字母文字，不做色块等替代图形 */
:where(.brand-logo--monogram) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
}
</style>
