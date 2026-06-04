import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'AgentPulse',
  description: 'Local-first event center for AI agent tools',
  base: '/docs/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'CLI', link: '/guide/cli' },
      { text: '代理配置', link: '/guide/proxy' }
    ],
    sidebar: [
      {
        text: '使用文档',
        items: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: 'Web 控制台', link: '/guide/web-console' },
          { text: 'CLI 命令', link: '/guide/cli' },
          { text: '代理配置', link: '/guide/proxy' },
          { text: '安全与回滚', link: '/guide/safety' },
          { text: 'npm 发布', link: '/guide/npm-publish' }
        ]
      }
    ],
    search: {
      provider: 'local'
    },
    socialLinks: []
  }
});
