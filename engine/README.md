# 引擎与权重目录

这个目录由 `tools/fetch-engine.ps1` 自动填充，内容**不进版本库**（`.gitignore` 已排除）。

## 目录结构

```
engine/
├── bin/
│   ├── opencl/          KataGo OpenCL 版（只依赖显卡驱动，默认使用）
│   ├── cuda/            KataGo CUDA 版（需本机已装 CUDA + cuDNN）
│   └── cpu/             KataGo Eigen CPU 版（无独显时的兜底）
├── models/
│   ├── kata1-b18c384nbt-*.bin.gz      主权重，决定棋力上限
│   ├── b18c384nbt-humanv0.bin.gz      人类风格权重，级位/低段位拟人化
│   └── kata1-b6c96-*.txt.gz           轻量权重，低配机器使用
├── logs/                引擎日志（运行时生成）
├── _download/           下载缓存（可安全删除）
└── hardware.log         硬件驱动为 log 模式时的指令日志
```

## 获取方式

```powershell
pwsh -File tools/fetch-engine.ps1
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Only opencl` | 只下载 OpenCL 版引擎 |
| `-SkipNets` | 只补引擎，不重复下载权重 |
| `-SkipHuman` | 不下载人类风格权重 |
| `-Force` | 强制重新下载 |

## 关于权重

KataGo 不需要自己训练。官方分布式训练项目
[katagotraining.org](https://katagotraining.org/networks/) 产出的 `.bin.gz` / `.txt.gz`
就是训练好的成品权重，下载后直接使用。

程序启动时会自动探测 `bin/` 下**能真正跑起来**的构建（例如缺少 cuDNN 的 CUDA 版会被跳过），
然后实测吞吐来决定用哪份权重。

## 手动放置

如果你想用自己的权重，直接把文件放进 `models/`，程序会自动识别：

- 体积最大的非 human 权重 → 主权重
- 文件名含 `human` 的权重 → 人类风格权重
- 体积最小的权重 → 轻量权重

也可以在 `config.json` 里显式指定：

```json
{
  "katago": {
    "path": "engine/bin/cuda/katago.exe",
    "model": "engine/models/kata1-b28c512nbt-xxxx.bin.gz",
    "humanModel": "engine/models/b18c384nbt-humanv0.bin.gz",
    "strength": "main"
  }
}
```
