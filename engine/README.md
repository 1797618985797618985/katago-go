# KataGo 引擎放置目录

把 KataGo 的可执行文件与神经网络权重放到这个目录，程序启动时会自动检测。

## 需要放置的文件

| 文件 | 说明 | 示例名 |
| --- | --- | --- |
| 可执行文件 | KataGo 主程序 | `katago.exe`（Windows） / `katago`（Linux、macOS） |
| 神经网络权重 | 主模型，决定棋力上限 | `model.bin.gz`（如 `kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`） |
| 人类风格模型（可选） | 用于「级位/段位」拟人化棋风 | `b18c384nbt-humanv0.bin.gz` |

目录形如：

```
engine/
├── katago.exe
├── model.bin.gz
├── b18c384nbt-humanv0.bin.gz      # 可选
└── gtp.cfg                        # 首次运行自动生成，可手动修改
```

## 下载地址

- 发布页（含各平台可执行文件与权重）：<https://github.com/lightvector/KataGo/releases>
- 权重下载页：<https://katagotraining.org/networks/>

Windows 用户下载 `katago-vX.Y.Z-opencl-windows-x64.zip`（NVIDIA/AMD 显卡用 OpenCL 或 CUDA 版，
纯 CPU 用 `eigen` 版），解压后把 `katago.exe` 与 `*.bin.gz` 放到本目录即可。

> 推荐使用 OpenCL/CUDA/TensorRT 版本，CPU 版本在 19 路棋盘上速度会明显偏慢。

## 检测规则

程序按以下顺序查找可执行文件与权重：

1. `config.json` 中显式配置的路径；
2. 本目录下匹配 `katago*`（或 `katago*.exe`）的文件；
3. 本目录下匹配 `*.bin.gz` / `*.txt.gz` 的文件作为权重。

如果都没找到，程序会自动切换到内置的轻量级引擎（见根目录 `README.md`）。
