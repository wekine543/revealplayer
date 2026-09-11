# RevealPlayer — 媒体叠加遮罩播放器

## 这是什么

RevealPlayer 是一个基于 WebGL 的媒体叠加播放器。你选择两个媒体源（A 和 B），A 作为默认显示层，B 作为隐藏层。播放时画面正常显示 A 的内容；当鼠标在画面上移动时，以鼠标为中心的圆形区域内显示 B 的内容，形成"探照灯"或"局部揭示"效果。

## 核心功能

| 功能 | 说明 |
|------|------|
| **媒体加载** | 支持视频（mp4/webm）和图片（jpg/png/webp/gif），可从本地文件或在线 URL 加载，支持拖拽上传 |
| **探照灯遮罩** | 鼠标移动时，圆形遮罩内显示 B 的内容，区域外显示 A，边缘带羽化过渡 |
| **视频同步** | A/B 两段视频帧级对齐（偏差 < 50ms），肉眼不可感知 |
| **遮罩调节** | 遮罩大小（20~500px）、羽化宽度（0~100px）、边框开关/粗细/颜色/透明度，均实时预览 |
| **播放控制** | 播放/暂停、进度条拖动跳转、音量控制、倍速播放（0.5x~2x）、循环播放、全屏、截图 |
| **收藏组合** | 一键保存 A/B 搭配及所有遮罩参数，刷新页面后仍然保留，支持加载/删除/重命名 |

## 技术栈

- **React 19 + TypeScript** — 前端框架
- **Three.js + WebGL** — GPU 渲染，自定义 GLSL 着色器实现遮罩混合
- **Zustand** — 状态管理
- **Tailwind CSS** — 界面样式
- **IndexedDB** — 本地文件和收藏组合的持久化存储

## 如何使用

### 方式一：双击打开（推荐，零门槛）

桌面上的 `RevealPlayer.html` 文件，**双击即可用浏览器打开**，无需安装任何环境、无需终端命令。所有功能（媒体加载、遮罩、收藏等）均可正常使用。

> 如需重新生成此文件，在项目目录执行 `npm run build`，产物在 `dist/index.html`。

### 方式二：一键启动脚本（开发模式）

双击项目目录下的 `RevealPlayer.bat`，会自动启动本地服务器并打开浏览器。用完后关闭弹出的终端窗口即可。

### 方式三：手动命令行（开发者）

```bash
cd "C:/Users/ZhenTao/WorkBuddy AI/2026-09-11-13-17-29/revealplayer"
npm run dev
```

浏览器打开 `http://localhost:5174` 即可使用。关闭时在终端按 `Ctrl + C`。

### 打包

```bash
npm run build      # 打包为单个 HTML 文件到 dist/index.html
npm run preview    # 本地预览打包结果
```

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `空格` / `K` | 播放 / 暂停 |
| `←` | 后退 5 秒 |
| `→` | 前进 5 秒 |
| 鼠标滚轮 | 调节遮罩半径 |

## 使用场景

- **视频创作者**：对比调色前后、特效前后的视频
- **设计师**：图片 A/B 对比，展示设计细节差异
- **演示者**：产品功能对比、培训材料展示
- **普通用户**：趣味互动，隐藏内容揭示（彩蛋）

## 项目结构

```
revealplayer/
├── src/
│   ├── lib/
│   │   ├── engine.ts        # Three.js 渲染引擎单例
│   │   ├── SyncManager.ts    # 视频帧级同步管理器
│   │   ├── shaders.ts         # GLSL 顶点/片元着色器
│   │   ├── db.ts              # IndexedDB 数据读写
│   │   └── media.ts          # 媒体加载工具函数
│   ├── store/useStore.ts      # Zustand 全局状态
│   ├── types/index.ts         # TypeScript 类型定义
│   ├── components/
│   │   ├── CanvasView.tsx     # WebGL 画布 + 鼠标交互
│   │   ├── MediaLoader.tsx    # A/B 媒体加载区
│   │   ├── PlaybackControls.tsx
│   │   ├── MaskControls.tsx
│   │   ├── FavoriteButton.tsx
│   │   └── FavoriteList.tsx
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```
