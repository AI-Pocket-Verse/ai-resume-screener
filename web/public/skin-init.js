// 首屏皮肤：必须在 CSS 之前同步执行，否则会先用默认皮肤渲染再跳到用户选的那套（闪一下）。
// 放成独立文件而不是内联脚本，是为了让部署时的 CSP 可以只写 script-src 'self'。
// key 必须与 @ai-resume-screener/design-tokens 的 SKIN_STORAGE_KEY 一致。
try {
  document.documentElement.dataset.skin = localStorage.getItem('ai-resume-screener.skin') || 'a'
} catch (e) {
  document.documentElement.dataset.skin = 'a'
}
