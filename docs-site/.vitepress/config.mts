import { defineConfig } from 'vitepress'
import { guideLinks } from './guide-links.mts'

const guideRouteMap: Record<string, string> = {
  'README.md': 'docs/architecture',
  'walkthroughs/one-real-run.md': 'docs/walkthrough',
  'code-map.md': 'docs/code-map',
  'modules/windowed-iso-and-download.md': 'docs/contracts',
  'modules/runtime-perf-and-stability.md': 'docs/performance',
  'modules/adhoc-relay-protocol.md': 'docs/contracts',
  'modules/touch-gamepad-and-viewport.md': 'docs/architecture',
  'glossary.md': 'docs/architecture',
  'references/source-evidence.md': 'docs/architecture',
  'references/quality-review.md': 'docs/architecture',
  'change-log.md': 'docs/decisions',
}

export default defineConfig({
  title: 'PPSSPW',
  description: '浏览器端 PPSSPP WebAssembly 模拟器：8 MiB 分窗读盘、OPFS 持久化存档、分块续传下载与自托管中继栈。',
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    config(md) {
      md.use(guideLinks(guideRouteMap))
    },
  },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '首页', link: '/' },
          { text: '起步与部署', link: '/docs/' },
          { text: '契约与调优', link: '/docs/contracts' },
          { text: '架构与源码', link: '/docs/architecture' },
          { text: 'API 与组件', link: '/api-reference/' },
        ],
        sidebar: {
          '/docs/': [
            {
              text: '起步与配置部署',
              items: [
                { text: '概览与运行边界', link: '/docs/' },
                { text: '部署模式与下载清单准备', link: '/docs/deployment' },
                { text: 'API 与组件参考（Apifox 视图）', link: '/api-reference/' },
                { text: '部署与运行排错 FAQ', link: '/docs/troubleshooting' },
              ],
            },
            {
              text: '契约与性能调优',
              items: [
                { text: '8 MiB 分窗、续传与中继契约', link: '/docs/contracts' },
                { text: '画质倍率、音频与稳定性调优', link: '/docs/performance' },
              ],
            },
            {
              text: '原理与源码导览',
              items: [
                { text: '架构全景与交互图谱', link: '/docs/architecture' },
                { text: '一次真实运行走查（源码）', link: '/docs/walkthrough' },
                { text: '代码地图（按职责定位）', link: '/docs/code-map' },
                { text: '工程决策与调查迁移', link: '/docs/decisions' },
              ],
            },
          ],
        },
        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Getting Started', link: '/en/docs/' },
          { text: 'Contracts & Perf', link: '/en/docs/contracts' },
          { text: 'Architecture', link: '/en/docs/architecture' },
          { text: 'API & Components', link: '/en/api-reference/' },
        ],
        sidebar: {
          '/en/docs/': [
            {
              text: 'Getting Started & Deployment',
              items: [
                { text: 'Overview & Scope Boundaries', link: '/en/docs/' },
                { text: 'Deployment, Headers & Manifests', link: '/en/docs/deployment' },
                { text: 'API & Component Reference', link: '/en/api-reference/' },
                { text: 'Deployment & Runtime FAQ', link: '/en/docs/troubleshooting' },
              ],
            },
            {
              text: 'Contracts & Performance',
              items: [
                { text: '8 MiB Window, Range & Relay Contracts', link: '/en/docs/contracts' },
                { text: 'Render Scale, Audio & Stability Tuning', link: '/en/docs/performance' },
              ],
            },
            {
              text: 'Architecture & Decisions',
              items: [
                { text: 'Architecture & Interactive Diagram', link: '/en/docs/architecture' },
                { text: 'Decisions, ADRs & Investigations', link: '/en/docs/decisions' },
              ],
            },
          ],
        },
        outline: { label: 'On this page', level: [2, 3] },
      },
    },
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/CyberNova2333/ppsspw' }],
  },
})
