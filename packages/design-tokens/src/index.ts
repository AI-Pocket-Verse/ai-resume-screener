/**
 * @ai-resume-screener/design-tokens —— 视觉体系的唯一真理源。
 *
 * 颜色/圆角/阴影【只在 CSS 里定义】(structure.css + skins/*.css),不在 TS 里存第二份 ——
 * 存两份必然漂移,且皮肤要能在运行时切换,TS 常量做不到。
 * 本入口只导出皮肤切换的运行时。
 */
export * from './skin'
